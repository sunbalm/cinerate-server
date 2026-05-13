require("dotenv").config();

const express = require("express");
const cors = require("cors");

const app = express();

const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

// Routes
app.get("/", (req, res) => {
  res.json({
    message: "Server is running",
  });
});

app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    timestamp: new Date(),
  });
});

app.post("/api/test", (req, res) => {
  console.log(req.body);

  res.json({
    received: req.body,
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});