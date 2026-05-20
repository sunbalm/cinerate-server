require("dotenv").config();

const crypto = require("crypto");
const express = require("express");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");

const app = express();

const PORT = process.env.PORT || 5000;
const CLIENT_URL = process.env.CLIENT_URL || "http://localhost:3000";

const CHOOSE_MOVIE_SECONDS = 60;
const ROUND_RESULTS_SECONDS = 10;
const GAME_OVER_SECONDS = 15;

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

// Active users; key = socket id.
const users = {};

// Active games; key = room id.
const games = {};

// Server-owned room timers; key = room id.
const gameTimers = {};

function generateRoomID() {
  return crypto.randomUUID();
}

function getOnlineUserCount() {
  return Object.keys(users).length;
}

function parseBoundedInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);

  if (Number.isNaN(parsed)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, parsed));
}

function buildGamePayload(game) {
  return {
    gameData: game,
    serverNow: Date.now(),
  };
}

function serializePublicGame(game) {
  return {
    roomID: game.roomID,
    host: game.host,
    playerCount: game.playerCount,
    players: game.players.map(({ name, socketID }) => ({ name, socketID })),
    gameName: game.gameName,
    active: game.active,
    winCount: game.winCount,
  };
}

function getPublicGames() {
  return Object.fromEntries(
    Object.entries(games)
      .filter(([, game]) => {
        return (
          !game.password &&
          !game.active &&
          game.players.length < game.playerCount
        );
      })
      .map(([roomID, game]) => [roomID, serializePublicGame(game)])
  );
}

function publishPublicGames() {
  io.emit("games", getPublicGames());
}

function emitGame(roomID, event = "update_game") {
  const game = games[roomID];

  if (!game) {
    return;
  }

  io.to(roomID).emit(event, buildGamePayload(game));
}

function emitGameToSocket(socketID, game, event = "update_game") {
  io.to(socketID).emit(event, buildGamePayload(game));
}

function sendOk(ack, payload = {}) {
  if (typeof ack === "function") {
    ack({ ok: true, ...payload });
  }
}

function sendError(socket, ack, message) {
  if (typeof ack === "function") {
    ack({ ok: false, error: message });
  }

  socket.emit("game_error", { message });
}

function isPlayerInGame(game, socketID) {
  return game.players.some((player) => player.socketID === socketID);
}

function findRoomForPlayer(socketID) {
  return Object.keys(games).find((roomID) => {
    return isPlayerInGame(games[roomID], socketID);
  });
}

function clearGameTimer(roomID, clearTimerState = true) {
  if (gameTimers[roomID]) {
    clearTimeout(gameTimers[roomID]);
    delete gameTimers[roomID];
  }

  if (clearTimerState && games[roomID]) {
    games[roomID].timer = null;
  }
}

function setGameTimer(roomID, kind, duration, onExpire) {
  const game = games[roomID];

  if (!game) {
    return;
  }

  clearGameTimer(roomID);

  const startedAt = Date.now();

  game.timer = {
    kind,
    duration,
    startedAt,
    endsAt: startedAt + duration * 1000,
  };

  gameTimers[roomID] = setTimeout(() => {
    delete gameTimers[roomID];
    onExpire();
  }, duration * 1000);
}

function removeGame(roomID, reason = "closed") {
  if (!games[roomID]) {
    return;
  }

  clearGameTimer(roomID);
  io.to(roomID).emit("game_removed", { roomID, reason });
  io.in(roomID).socketsLeave(roomID);

  delete games[roomID];
  publishPublicGames();
}

function syncDealer(game) {
  if (game.players.length === 0) {
    game.dealer = null;
    game.dealerIndex = 0;
    return;
  }

  if (typeof game.dealerIndex !== "number") {
    game.dealerIndex = 0;
  }

  game.dealerIndex =
    ((game.dealerIndex % game.players.length) + game.players.length) %
    game.players.length;
  game.dealer = game.players[game.dealerIndex];
}

function rotateDealer(game) {
  if (game.players.length === 0) {
    return;
  }

  if (typeof game.dealerIndex !== "number") {
    game.dealerIndex = -1;
  }

  game.dealerIndex = (game.dealerIndex + 1) % game.players.length;
  syncDealer(game);
}

function ensureScoresForCurrentPlayers(game) {
  const previousScores = new Map(
    (game.scores || []).map((player) => [player.socketID, player.score])
  );

  game.scores = game.players.map((player) => ({
    ...player,
    score: previousScores.get(player.socketID) || 0,
  }));
}

function getGameWinners(game) {
  return (game.scores || []).filter((player) => player.score >= game.winCount);
}

function addScore(game) {
  const actualRating = Number(game.guessMovie?.imdbRating);

  if (Number.isNaN(actualRating)) {
    game.roundWinners = [];
    return game;
  }

  const validGuesses = game.guesses
    .map((guess) => ({
      ...guess,
      movieRating: Number(guess.movieRating),
    }))
    .filter((guess) => guess.movieRating <= actualRating);

  if (validGuesses.length === 0) {
    game.roundWinners = [];
    return game;
  }

  const closestGuess = Math.max(
    ...validGuesses.map((guess) => guess.movieRating)
  );

  const winners = validGuesses.filter((guess) => {
    return guess.movieRating === closestGuess;
  });

  game.roundWinners = winners;

  game.scores = game.scores.map((playerScore) => {
    const wonPoint = winners.some((winner) => {
      return winner.user === playerScore.socketID;
    });

    return {
      ...playerScore,
      score: wonPoint ? playerScore.score + 1 : playerScore.score,
    };
  });

  return game;
}

function handleChooseMovieTimeout(roomID, dealerSocketID) {
  const game = games[roomID];

  if (
    !game ||
    game.state !== "choose movie" ||
    game.dealer?.socketID !== dealerSocketID
  ) {
    return;
  }

  startChooseMovie(roomID, { rotate: true });

  if (games[roomID]) {
    io.to(roomID).emit("dealer_skipped", buildGamePayload(games[roomID]));
  }
}

function startChooseMovie(roomID, { rotate = false } = {}) {
  const game = games[roomID];

  if (!game) {
    return;
  }

  if (game.players.length === 0) {
    removeGame(roomID, "empty");
    return;
  }

  if (rotate) {
    rotateDealer(game);
  } else {
    syncDealer(game);
  }

  game.active = true;
  game.state = "choose movie";
  game.roundWinners = [];
  game.guesses = [];
  game.guessMovie = null;

  const dealerSocketID = game.dealer?.socketID;

  setGameTimer(roomID, "choose_movie", CHOOSE_MOVIE_SECONDS, () => {
    handleChooseMovieTimeout(roomID, dealerSocketID);
  });

  emitGame(roomID);
}

function startSubmitRating(roomID, movie) {
  const game = games[roomID];

  if (!game) {
    return;
  }

  clearGameTimer(roomID);
  game.guessMovie = movie;
  game.state = "submit rating";
  game.guesses = [];

  const payload = buildGamePayload(game);
  io.to(roomID).emit("update_game", payload);
  io.to(roomID).emit("movie_set", payload);
}

function finishGame(roomID, winners, reason = "completed") {
  const game = games[roomID];

  if (!game) {
    return false;
  }

  clearGameTimer(roomID);
  game.winners = winners;
  game.state = "game over";
  game.timer = null;

  setGameTimer(roomID, "game_over", GAME_OVER_SECONDS, () => {
    removeGame(roomID, reason);
  });

  emitGame(roomID);
  publishPublicGames();

  return true;
}

function finishGameIfLastPlayer(roomID) {
  const game = games[roomID];

  if (
    !game ||
    !game.active ||
    game.state === "game over" ||
    game.players.length !== 1
  ) {
    return false;
  }

  ensureScoresForCurrentPlayers(game);

  const remainingPlayer = game.players[0];
  const winner =
    game.scores.find((score) => score.socketID === remainingPlayer.socketID) ||
    {
      ...remainingPlayer,
      score: 0,
    };

  return finishGame(roomID, [winner], "completed");
}

function advanceAfterResults(roomID) {
  const game = games[roomID];

  if (!game) {
    return;
  }

  const winners = getGameWinners(game);

  if (winners.length > 0) {
    finishGame(roomID, winners);
    return;
  }

  startChooseMovie(roomID, { rotate: true });
}

function resolveRound(roomID) {
  const game = games[roomID];

  if (!game || game.state !== "submit rating") {
    return;
  }

  ensureScoresForCurrentPlayers(game);
  addScore(game);
  game.state = "view round results";

  setGameTimer(roomID, "round_results", ROUND_RESULTS_SECONDS, () => {
    advanceAfterResults(roomID);
  });

  emitGame(roomID);
}

function updateUserNameInGames(socketID, name) {
  Object.values(games).forEach((game) => {
    const hasPlayer = isPlayerInGame(game, socketID);

    if (!hasPlayer) {
      return;
    }

    game.players = game.players.map((player) => {
      if (player.socketID !== socketID) {
        return player;
      }

      return { ...player, name };
    });

    if (game.dealer?.socketID === socketID) {
      game.dealer = { ...game.dealer, name };
    }

    if (Array.isArray(game.scores)) {
      game.scores = game.scores.map((playerScore) => {
        if (playerScore.socketID !== socketID) {
          return playerScore;
        }

        return { ...playerScore, name };
      });
    }

    emitGame(game.roomID);
  });

  publishPublicGames();
}

function removePlayerFromGame(roomID, socketID) {
  const game = games[roomID];

  if (!game) {
    return;
  }

  const playerIndex = game.players.findIndex((player) => {
    return player.socketID === socketID;
  });

  if (playerIndex === -1) {
    return;
  }

  const stateBeforeRemoval = game.state;
  const dealerRemoved = game.dealer?.socketID === socketID;

  game.players = game.players.filter((player) => player.socketID !== socketID);
  game.guesses = (game.guesses || []).filter((guess) => {
    return guess.user !== socketID;
  });
  game.roundWinners = (game.roundWinners || []).filter((winner) => {
    return winner.user !== socketID;
  });
  game.winners = (game.winners || []).filter((winner) => {
    return winner.socketID !== socketID;
  });
  game.scores = (game.scores || []).filter((playerScore) => {
    return playerScore.socketID !== socketID;
  });

  if (game.players.length === 0) {
    removeGame(roomID, "empty");
    return;
  }

  if (game.host === socketID || !isPlayerInGame(game, game.host)) {
    game.host = game.players[0].socketID;
  }

  if (finishGameIfLastPlayer(roomID)) {
    return;
  }

  if (typeof game.dealerIndex !== "number") {
    game.dealerIndex = 0;
  } else if (playerIndex < game.dealerIndex) {
    game.dealerIndex -= 1;
  } else if (playerIndex === game.dealerIndex) {
    if (stateBeforeRemoval === "choose movie") {
      game.dealerIndex = playerIndex;
    } else {
      game.dealerIndex = playerIndex - 1;
    }
  }

  syncDealer(game);

  if (game.active && stateBeforeRemoval === "choose movie" && dealerRemoved) {
    startChooseMovie(roomID);
    publishPublicGames();
    return;
  }

  if (
    game.active &&
    stateBeforeRemoval === "submit rating" &&
    game.guesses.length >= game.players.length
  ) {
    resolveRound(roomID);
    publishPublicGames();
    return;
  }

  emitGame(roomID);
  publishPublicGames();
}

io.on("connection", (socket) => {
  users[socket.id] = {
    name: socket.id,
    socketID: socket.id,
  };

  io.emit("online_users", getOnlineUserCount());
  publishPublicGames();

  socket.on("update_name", ({ name } = {}) => {
    if (!users[socket.id]) {
      return;
    }

    const nextName = String(name || "").trim().slice(0, 15) || socket.id;

    users[socket.id].name = nextName;
    socket.emit("updated_name", { name: nextName });
    updateUserNameInGames(socket.id, nextName);
  });

  socket.on("join_game", ({ targetGame, password } = {}, ack) => {
    const game = games[targetGame];

    if (!game) {
      sendError(socket, ack, "That game is no longer available.");
      publishPublicGames();
      return;
    }

    if (isPlayerInGame(game, socket.id)) {
      socket.join(game.roomID);
      emitGameToSocket(socket.id, game);
      sendOk(ack, { gameData: game, alreadyJoined: true });
      return;
    }

    const existingRoomID = findRoomForPlayer(socket.id);

    if (existingRoomID) {
      sendError(socket, ack, "You are already in a game.");
      return;
    }

    if (game.active) {
      sendError(socket, ack, "That game has already started.");
      publishPublicGames();
      return;
    }

    if (game.players.length >= game.playerCount) {
      sendError(socket, ack, "That game is already full.");
      publishPublicGames();
      return;
    }

    if (game.password && game.password !== String(password || "")) {
      sendError(socket, ack, "Incorrect game password.");
      return;
    }

    if (!users[socket.id]) {
      sendError(socket, ack, "You are not connected.");
      return;
    }

    game.players.push({ ...users[socket.id] });
    socket.join(game.roomID);

    emitGame(game.roomID);
    publishPublicGames();
    sendOk(ack, { gameData: game });
  });

  socket.on(
    "create_game",
    ({ gameName, playerCount, password, winCount } = {}, ack) => {
      if (findRoomForPlayer(socket.id)) {
        sendError(socket, ack, "You are already in a game.");
        return;
      }

      if (!users[socket.id]) {
        sendError(socket, ack, "You are not connected.");
        return;
      }

      const roomID = generateRoomID();
      const normalizedGameName =
        String(gameName || "").trim().slice(0, 50) || "CineRate Room";

      const newGame = {
        host: socket.id,
        password: String(password || "").trim(),
        playerCount: parseBoundedInteger(playerCount, 2, 2, 10),
        players: [{ ...users[socket.id] }],
        gameName: normalizedGameName,
        active: false,
        roomID,
        winCount: parseBoundedInteger(winCount, 5, 1, 15),
        state: "lobby",
        guesses: [],
        roundWinners: [],
        winners: [],
        scores: [],
        timer: null,
        dealer: null,
        dealerIndex: 0,
      };

      games[roomID] = newGame;
      socket.join(roomID);

      publishPublicGames();
      emitGameToSocket(socket.id, newGame);
      sendOk(ack, { gameData: newGame });
    }
  );

  socket.on("leave_game", ({ roomID } = {}, ack) => {
    const game = games[roomID];

    if (!game || !isPlayerInGame(game, socket.id)) {
      socket.emit("left_game", { roomID });
      sendOk(ack);
      return;
    }

    if (game.active) {
      sendError(socket, ack, "You can only leave before the game starts.");
      return;
    }

    socket.leave(roomID);
    removePlayerFromGame(roomID, socket.id);
    socket.emit("left_game", { roomID });
    sendOk(ack);
  });

  socket.on("start_game", ({ roomID } = {}, ack) => {
    const game = games[roomID];

    if (!game) {
      sendError(socket, ack, "That game is no longer available.");
      return;
    }

    if (game.host !== socket.id) {
      sendError(socket, ack, "Only the host can start the game.");
      return;
    }

    if (game.active) {
      sendError(socket, ack, "That game has already started.");
      return;
    }

    if (game.players.length < 2) {
      sendError(socket, ack, "You need at least two players to start.");
      return;
    }

    game.active = true;
    game.guesses = [];
    game.roundWinners = [];
    game.winners = [];
    game.guessMovie = null;
    game.scores = game.players.map((player) => ({
      ...player,
      score: 0,
    }));
    game.dealerIndex = Math.floor(Math.random() * game.players.length);
    syncDealer(game);

    startChooseMovie(roomID);
    publishPublicGames();

    if (games[roomID]) {
      io.to(roomID).emit("started_game", buildGamePayload(games[roomID]));
    }

    sendOk(ack, { gameData: games[roomID] });
  });

  socket.on("set_movie", ({ roomID, game: clientGame, movie } = {}, ack) => {
    const targetRoomID = roomID || clientGame?.roomID;
    const game = games[targetRoomID];

    if (!game) {
      sendError(socket, ack, "That game is no longer available.");
      return;
    }

    if (game.state !== "choose movie") {
      sendError(socket, ack, "Movies can only be chosen during the movie pick.");
      return;
    }

    if (game.dealer?.socketID !== socket.id) {
      sendError(socket, ack, "Only the dealer can choose the movie.");
      return;
    }

    if (!movie?.imdbID) {
      sendError(socket, ack, "Choose a valid movie.");
      return;
    }

    startSubmitRating(targetRoomID, movie);
    sendOk(ack, { gameData: games[targetRoomID] });
  });

  socket.on(
    "submit_rating",
    ({ roomID, game: clientGame, movieRating } = {}, ack) => {
      const targetRoomID = roomID || clientGame?.roomID;
      const game = games[targetRoomID];

      if (!game) {
        sendError(socket, ack, "That game is no longer available.");
        return;
      }

      if (game.state !== "submit rating") {
        sendError(socket, ack, "Ratings are not open right now.");
        return;
      }

      if (!isPlayerInGame(game, socket.id)) {
        sendError(socket, ack, "You are not in this game.");
        return;
      }

      if (game.guesses.some((guess) => guess.user === socket.id)) {
        sendError(socket, ack, "Your rating has already been submitted.");
        return;
      }

      const parsedRating = Number(movieRating);

      if (Number.isNaN(parsedRating) || parsedRating < 0 || parsedRating > 10) {
        sendError(socket, ack, "Rating must be between 0 and 10.");
        return;
      }

      game.guesses.push({
        user: socket.id,
        movieRating: Math.round(parsedRating * 10) / 10,
      });

      if (game.guesses.length >= game.players.length) {
        resolveRound(targetRoomID);
      } else {
        emitGame(targetRoomID);
      }

      sendOk(ack, { gameData: games[targetRoomID] });
    }
  );

  socket.on("disconnect", () => {
    Object.keys(games).forEach((roomID) => {
      removePlayerFromGame(roomID, socket.id);
    });

    delete users[socket.id];

    io.emit("online_users", getOnlineUserCount());
    publishPublicGames();
  });
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
