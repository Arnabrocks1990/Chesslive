FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends stockfish && rm -rf /var/lib/apt/lists/*
WORKDIR /app
# Wheels are pre-downloaded on the host (the corporate proxy breaks TLS inside the build).
COPY wheels ./wheels
RUN pip install --no-index --find-links wheels chess==1.11.2 redis==5.2.1 "psycopg[binary]==3.2.3" numpy==2.1.3 typing_extensions
COPY worker.py .
ENV STOCKFISH_PATH=/usr/games/stockfish
CMD ["python", "-u", "worker.py"]
