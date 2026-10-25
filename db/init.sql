CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  username      TEXT UNIQUE NOT NULL,
  password_hash TEXT,
  role          TEXT NOT NULL DEFAULT 'player', -- admin | player | guest | bot
  rating        INT NOT NULL DEFAULT 600,       -- Elo
  rated_games   INT NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- default was 1200 before; existing accounts keep their rating, new ones start at 600
ALTER TABLE users ALTER COLUMN rating SET DEFAULT 600;

CREATE TABLE IF NOT EXISTS games (
  id               SERIAL PRIMARY KEY,
  code             TEXT UNIQUE NOT NULL,
  white_id         INT REFERENCES users(id),
  black_id         INT REFERENCES users(id),
  created_by       INT REFERENCES users(id),
  creator_color    TEXT NOT NULL DEFAULT 'random',
  time_control_sec INT NOT NULL,
  increment_sec    INT NOT NULL DEFAULT 0,
  vs_bot           BOOLEAN NOT NULL DEFAULT false,
  bot_elo          INT,         -- NULL = full strength
  white_change     INT,         -- Elo change for White (NULL = unrated game)
  black_change     INT,
  status           TEXT NOT NULL DEFAULT 'waiting', -- waiting | active | finished
  result           TEXT,        -- 1-0 | 0-1 | 1/2-1/2
  termination      TEXT,        -- checkmate | resign | timeout | draw ...
  pgn              TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at         TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS moves (
  id         SERIAL PRIMARY KEY,
  game_id    INT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  ply        INT NOT NULL,        -- 1-based half-move number
  san        TEXT NOT NULL,
  uci        TEXT NOT NULL,
  fen_after  TEXT NOT NULL,
  clock_ms   INT NOT NULL,        -- mover's remaining time after the move
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (game_id, ply)
);

-- analysis of the position after `ply` half-moves (ply 0 = start position).
-- eval_cp is from White's point of view.
CREATE TABLE IF NOT EXISTS analyses (
  id          SERIAL PRIMARY KEY,
  game_id     INT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  ply         INT NOT NULL,
  fen         TEXT NOT NULL,
  top_moves   JSONB NOT NULL,
  eval_cp     INT,
  mate        INT,
  explanation TEXT,
  learned_win_prob REAL,  -- White win probability from the model trained on our games
  similar_positions JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (game_id, ply)
);

CREATE TABLE IF NOT EXISTS position_embeddings (
  id         SERIAL PRIMARY KEY,
  game_id    INT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  ply        INT NOT NULL,
  fen        TEXT NOT NULL,
  embedding  vector(768) NOT NULL,
  eval_cp    INT,
  result     TEXT,                -- filled in when the game finishes
  UNIQUE (game_id, ply)
);
CREATE INDEX IF NOT EXISTS position_embeddings_hnsw ON position_embeddings USING hnsw (embedding vector_cosine_ops);

-- logistic-regression "who wins from here" model trained on stored positions + game results
CREATE TABLE IF NOT EXISTS model_weights (
  id          SERIAL PRIMARY KEY,
  trained_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  n_samples   INT NOT NULL,
  n_games     INT NOT NULL,
  accuracy    REAL,
  weights     JSONB NOT NULL      -- {"w":[768 floats],"b":float}
);
