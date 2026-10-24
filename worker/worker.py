"""Analysis worker: consumes position jobs from Redis, runs Stockfish, stores the
analysis + a position embedding in Postgres (pgvector) and publishes the result."""
import json
import os
import time

import chess
import chess.engine
import numpy as np
import psycopg
import redis

REDIS_URL = os.environ.get("REDIS_URL", "redis://localhost:6380")
DATABASE_URL = os.environ.get("DATABASE_URL", "postgresql://chess:chess@localhost:5455/chess")
STOCKFISH_PATH = os.environ.get("STOCKFISH_PATH", "stockfish")
LIVE_DEPTH = int(os.environ.get("LIVE_DEPTH", "16"))
POST_DEPTH = int(os.environ.get("POST_DEPTH", "12"))
MATE_CP = 10000

PIECE_PLANE = {
    (chess.PAWN, True): 0, (chess.KNIGHT, True): 1, (chess.BISHOP, True): 2,
    (chess.ROOK, True): 3, (chess.QUEEN, True): 4, (chess.KING, True): 5,
    (chess.PAWN, False): 6, (chess.KNIGHT, False): 7, (chess.BISHOP, False): 8,
    (chess.ROOK, False): 9, (chess.QUEEN, False): 10, (chess.KING, False): 11,
}


def embed(board: chess.Board) -> str:
    """12x64 piece-plane encoding, L2-normalised, as a pgvector literal."""
    v = np.zeros(768, dtype=np.float32)
    for sq, piece in board.piece_map().items():
        v[PIECE_PLANE[(piece.piece_type, piece.color)] * 64 + sq] = 1.0
    n = np.linalg.norm(v)
    if n:
        v /= n
    return "[" + ",".join(f"{x:.5f}" for x in v) + "]"


def score_fields(score: chess.engine.PovScore):
    white = score.white()
    mate = white.mate()
    cp = white.score(mate_score=MATE_CP)
    return max(-MATE_CP, min(MATE_CP, cp)), mate


def analyse(engine, board: chess.Board, depth: int, multipv: int):
    infos = engine.analyse(board, chess.engine.Limit(depth=depth), multipv=multipv)
    top = []
    for info in infos:
        pv = info.get("pv") or []
        if not pv:
            continue
        cp, mate = score_fields(info["score"])
        top.append({
            "uci": pv[0].uci(),
            "san": board.san(pv[0]),
            "eval_cp": cp,
            "mate": mate,
            "pv": board.variation_san(pv[:8]),
        })
    return top


def similar_positions(cur, vec: str, game_id: int, limit: int = 5):
    cur.execute(
        """SELECT fen, eval_cp, result, 1 - (embedding <=> %s::vector) AS sim
           FROM position_embeddings WHERE game_id <> %s
           ORDER BY embedding <=> %s::vector LIMIT %s""",
        (vec, game_id, vec, limit),
    )
    return [
        {"fen": r[0], "eval_cp": r[1], "result": r[2], "similarity": round(float(r[3]), 4)}
        for r in cur.fetchall()
    ]


MODEL = {"w": None, "b": 0.0}  # learned White-win model, refreshed after every training run
MIN_TRAIN_SAMPLES = 100
_limited = False


def set_strength(engine, elo):
    """elo=None means full strength; analysis must always run at full strength."""
    global _limited
    want = elo is not None
    if want:
        engine.configure({"UCI_LimitStrength": True, "UCI_Elo": max(1320, min(3190, int(elo)))})
    elif _limited:
        engine.configure({"UCI_LimitStrength": False})
    _limited = want


def parse_vec(text: str) -> np.ndarray:
    return np.array(text.strip("[]").split(","), dtype=np.float32)


def predict(vec: str):
    """White win probability from the learned model, or None before the first training run."""
    if MODEL["w"] is None:
        return None
    z = float(MODEL["w"] @ parse_vec(vec) + MODEL["b"])
    return float(1 / (1 + np.exp(-z)))


def load_model(conn):
    with conn.cursor() as cur:
        cur.execute("SELECT weights FROM model_weights ORDER BY id DESC LIMIT 1")
        row = cur.fetchone()
    conn.commit()
    if row:
        MODEL["w"] = np.array(row[0]["w"], dtype=np.float32)
        MODEL["b"] = float(row[0]["b"])


def train(conn):
    """Logistic regression: position embedding -> game outcome (win=1, draw=0.5, loss=0).
    Positions from the same game are never split between train/validation."""
    with conn.cursor() as cur:
        cur.execute("SELECT game_id, embedding::text, result FROM position_embeddings WHERE result IS NOT NULL")
        rows = cur.fetchall()
    conn.commit()
    if len(rows) < MIN_TRAIN_SAMPLES:
        print(f"train skipped: {len(rows)} labelled positions (< {MIN_TRAIN_SAMPLES})", flush=True)
        return
    game_ids = np.array([r[0] for r in rows])
    X = np.stack([parse_vec(r[1]) for r in rows])
    y = np.array([{"1-0": 1.0, "0-1": 0.0}.get(r[2], 0.5) for r in rows], dtype=np.float32)
    games = np.unique(game_ids)
    rng = np.random.default_rng(0)
    val_games = set(rng.choice(games, size=max(1, len(games) // 5), replace=False)) if len(games) >= 5 else set()
    val = np.array([g in val_games for g in game_ids])
    Xt, yt = X[~val], y[~val]

    w = np.zeros(X.shape[1], dtype=np.float32)
    b = 0.0
    for _ in range(600):
        p = 1 / (1 + np.exp(-(Xt @ w + b)))
        grad = p - yt
        w -= 8.0 * (Xt.T @ grad / len(yt) + 1e-3 * w)
        b -= 8.0 * grad.mean()

    def acc(Xe, ye):
        decisive = ye != 0.5
        if not decisive.any():
            return None
        pred = (Xe[decisive] @ w + b) > 0
        return float((pred == (ye[decisive] == 1.0)).mean())

    a = acc(X[val], y[val]) if val.any() else acc(Xt, yt)
    with conn.cursor() as cur:
        cur.execute(
            "INSERT INTO model_weights (n_samples, n_games, accuracy, weights) VALUES (%s,%s,%s,%s)",
            (len(rows), len(games), a, json.dumps({"w": [float(x) for x in w], "b": float(b)})),
        )
    conn.commit()
    MODEL["w"], MODEL["b"] = w, b
    print(f"trained on {len(rows)} positions / {len(games)} games, "
          f"{'validation' if val.any() else 'training'} accuracy {a}", flush=True)


def handle_bot(job, engine, rds):
    board = chess.Board(job["fen"])
    set_strength(engine, job.get("elo"))
    result = engine.play(board, chess.engine.Limit(time=0.5))
    rds.publish("analysis:results", json.dumps({
        "kind": "bot", "gameId": job["gameId"], "code": job["code"], "fen": job["fen"], "uci": result.move.uci(),
    }))


def handle(job, engine, conn, rds):
    kind = job.get("kind", "live")
    if kind == "train":
        return train(conn)
    if kind == "bot":
        return handle_bot(job, engine, rds)
    set_strength(engine, None)
    board = chess.Board(job["fen"])
    if kind == "live":
        top = analyse(engine, board, LIVE_DEPTH, 3)
    else:
        top = analyse(engine, board, POST_DEPTH, 1)
    if not top:  # game-over position, nothing to suggest
        return
    eval_cp, mate = top[0]["eval_cp"], top[0]["mate"]
    vec = embed(board)
    learned = predict(vec)
    with conn.cursor() as cur:
        similar = similar_positions(cur, vec, job["gameId"]) if kind == "live" else None
        cur.execute(
            """INSERT INTO analyses (game_id, ply, fen, top_moves, eval_cp, mate, similar_positions, learned_win_prob)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s)
               ON CONFLICT (game_id, ply) DO UPDATE SET fen=EXCLUDED.fen, top_moves=EXCLUDED.top_moves,
                 eval_cp=EXCLUDED.eval_cp, mate=EXCLUDED.mate, similar_positions=EXCLUDED.similar_positions,
                 learned_win_prob=EXCLUDED.learned_win_prob""",
            (job["gameId"], job["ply"], job["fen"], json.dumps(top), eval_cp, mate,
             json.dumps(similar) if similar is not None else None, learned),
        )
        cur.execute(
            """INSERT INTO position_embeddings (game_id, ply, fen, embedding, eval_cp, result)
               VALUES (%s,%s,%s,%s::vector,%s,(SELECT result FROM games WHERE id=%s))
               ON CONFLICT (game_id, ply) DO UPDATE SET embedding=EXCLUDED.embedding, eval_cp=EXCLUDED.eval_cp,
                 result=COALESCE(EXCLUDED.result, position_embeddings.result)""",
            (job["gameId"], job["ply"], job["fen"], vec, eval_cp, job["gameId"]),
        )
    conn.commit()
    rds.publish("analysis:results", json.dumps({
        "gameId": job["gameId"], "code": job["code"], "ply": job["ply"], "fen": job["fen"],
        "kind": kind, "top_moves": top, "eval_cp": eval_cp, "mate": mate, "similar": similar,
        "learned_win_prob": learned,
    }))


def connect_db():
    """Blocks until Postgres accepts a connection (it may be restarting)."""
    while True:
        try:
            return psycopg.connect(DATABASE_URL)
        except Exception as e:
            print("waiting for postgres:", e, flush=True)
            time.sleep(2)


MAX_RETRIES = 2  # a failed job is retried before it is dropped; a lost bot move would leave a human waiting forever


def main():
    rds = redis.Redis.from_url(REDIS_URL)
    while True:
        try:
            rds.ping()
            break
        except Exception as e:  # services still starting
            print("waiting for redis:", e, flush=True)
            time.sleep(2)
    conn = connect_db()
    engine = chess.engine.SimpleEngine.popen_uci(STOCKFISH_PATH)
    engine.configure({"Threads": int(os.environ.get("SF_THREADS", "2")), "Hash": int(os.environ.get("SF_HASH", "128"))})
    load_model(conn)
    print("worker ready", flush=True)
    while True:
        try:
            # bot moves first (a human is waiting), then live suggestions, then post-game work
            item = rds.brpop(["analysis:bot", "analysis:live", "analysis:post"], timeout=5)
        except redis.exceptions.RedisError as e:
            print("redis unavailable, retrying:", e, flush=True)
            time.sleep(2)
            continue
        if not item:
            continue
        queue, raw = item[0].decode(), item[1]
        job = json.loads(raw)
        try:
            handle(job, engine, conn, rds)
        except Exception as e:
            print("job failed:", e, flush=True)
            try:
                conn.rollback()
            except Exception:
                conn = connect_db()  # the connection itself died (Postgres restarted): replace it
            retries = job.get("_retries", 0)
            gone = isinstance(e, psycopg.errors.ForeignKeyViolation)  # the game was deleted: a retry can never succeed
            if retries < MAX_RETRIES and job.get("kind") != "train" and not gone:
                job["_retries"] = retries + 1
                try:
                    rds.rpush(queue, json.dumps(job))  # back to the front: it is next in line (the loop pops from the right)
                except Exception:
                    pass
                time.sleep(1)


if __name__ == "__main__":
    main()
