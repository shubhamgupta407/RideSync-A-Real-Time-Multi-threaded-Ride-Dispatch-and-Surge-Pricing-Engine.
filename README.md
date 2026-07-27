# RideSync 

RideSync is a real-time ride dispatch and surge pricing engine I'm building. The idea is to simulate a modern ride-hailing architecture (like Uber) from scratch. 

It's split into two main parts: a multi-threaded C++ backend that handles all the heavy lifting (spatial tracking, dispatching, and pricing), and a vanilla JS/CSS frontend dashboard to visualize the city grid in real-time.

## Architecture

Here's a quick look at how the system is structured:

```mermaid
graph TD
    classDef frontend fill:#3b82f6,stroke:#2563eb,stroke-width:2px,color:#fff,rx:8px
    classDef backend fill:#10b981,stroke:#059669,stroke-width:2px,color:#fff,rx:8px
    classDef thread fill:#f59e0b,stroke:#d97706,stroke-width:2px,color:#fff,rx:8px

    subgraph Frontend
        UI[City Grid UI]:::frontend
        Feed[Live Activity Feed]:::frontend
        Stats[Stats Panel]:::frontend
    end

    subgraph Backend
        API[API Endpoint]:::backend
        Match[Matching Engine]:::backend
        Surge[Surge Pricing Module]:::backend
        
        subgraph Threads
            T1[Driver Thread 1]:::thread
            T2[Driver Thread 2]:::thread
            T3[Driver Thread N]:::thread
        end
    end

    UI -->|Polls| API
    API --> Match
    Match <--> Threads
    Match <--> Surge
```

## What's working right now

**Frontend (`frontend/`)**
- Built a Mapbox-style stylized abstract city map with avenue road networks, dashed centerlines, and block texture/shade variations.
- Renders top-down car vectors dynamically with above-surface drop shadows, directional rotation, and motion transition trails.
- Uses an anti-overlap arc clustering system so cars stay readable without clipping when sharing the same city block.
- **Elevated Landmark Labels**: Features iconic landmarks (🌲 Central Park, 🌊 East River Canal, 🏢 Financial District, 🎭 Midtown / Times Square) rendered on a high z-index layer so label text remains 100% visible above vehicle markers.
- **Simulation Controls**: Includes a live Simulation ON/OFF toggle button to pause or resume real-time state polling and rider spawning.
- **Fleet Metrics Breakdown**: Dashboard KPI cards show total active fleet capacity with an instant real-time subtext split (`X available · Y en route`).
- Live activity feed and multithreaded log streaming directly from the C++ engine.

**Backend (`backend/`)**
- Uses `std::thread` and `std::mutex` to spawn independent concurrent threads for drivers, riders, and a central dispatcher.
- **Real-Time HTTP Server**: Integrated standalone header-only HTTP server (`httplib.h` and `json.hpp`) serving live JSON state snapshots on `http://localhost:8081/state`.
- **Thread-safe Request Queue**: Uses a `std::condition_variable` to manage incoming ride requests efficiently without CPU-heavy busy waiting.
- **Matching Engine**: Dispatcher uses Euclidean distance to locate and lock the nearest available driver atomically.
- **Dynamic Surge Pricing**: Divides the city grid into geographic zones, calculating real-time supply vs demand (pending requests vs available drivers) to automatically apply surge multipliers and glowing radial heat-map overlays.

## How to run it

### Running the Live Integration
You can run the full integrated stack (C++ backend server + frontend UI):

1. **Start the C++ Backend Server:**
```bash
cd backend
clang++ -std=c++17 -pthread main.cpp -o sim
./sim
```
The server will start listening on port `8081`.

2. **Open the Frontend Dashboard:**
Open `frontend/index.html` directly in your browser or start a lightweight static server:
```bash
cd frontend
python3 -m http.server 8080
```
Then navigate to `http://localhost:8080` (or `http://localhost:8081` if serving static assets directly from the backend).

## What's next
- [x] Connect the frontend directly to the C++ backend via local HTTP API.
- [x] Build out the actual rider matching algorithm in C++.
- [x] Implement the surge pricing logic based on driver/rider density.
- [x] Implement Mapbox-style stylized operations map and simulation toggle controls.
- [ ] Add historical analytics and ride completion metrics.

Feel free to poke around the code or run the simulation locally!
