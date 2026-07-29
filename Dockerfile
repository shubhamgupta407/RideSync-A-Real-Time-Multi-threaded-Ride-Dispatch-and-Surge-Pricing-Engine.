#Build Stage: Compile C++17 Multithreaded Dispatch Engine
FROM debian:bookworm-slim AS builder

RUN apt-get update && apt-get install -y build-essential && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY backend/ ./backend/

#Compile with C++17 and pthread optimization
RUN g++ -std=c++17 -pthread -O2 backend/main.cpp -o /app/server

#Production Stage: Lightweight runtime container
FROM debian:bookworm-slim

WORKDIR /app
COPY --from=builder /app/server /app/server
COPY frontend/ ./frontend/

#Expose Render default port (or 8080)
EXPOSE 8080

#Run the multithreaded C++ dispatch engine & serve frontend HTML/JS
CMD ["/app/server"]
