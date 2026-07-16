# 🚖 RideSync: Real-Time Multi-threaded Ride Dispatch & Surge Pricing Engine

RideSync is a high-performance, concurrent C++ backend paired with a dynamic vanilla JavaScript frontend dashboard. It simulates a modern ride-hailing architecture (like Uber or Lyft) with real-time driver tracking, rider matching, and dynamic surge pricing.

## 🏗️ System Architecture

Our intended architecture splits the heavy lifting of spatial tracking and dispatching to a multi-threaded C++ backend, while the frontend provides a sleek, real-time visualization of the city grid.

```mermaid
graph TD;
    subgraph Frontend [Dashboard Viewport (JS/CSS/HTML)]
        UI[City Grid UI]
        Feed[Live Activity Feed]
        Stats[Stats Panel]
    end

    subgraph Backend [C++ Dispatch Engine]
        API[API Endpoint]
        Match[Matching Engine]
        Surge[Surge Pricing Module]
        
        subgraph Threads
            T1[Driver Thread 1]
            T2[Driver Thread 2]
            T3[Driver Thread N...]
        end
    end

    UI -->|Polls for State| API
    API --> Match
    Match <--> Threads
    Match <--> Surge
```

## ✨ Features (What we've built so far)

### 🖥️ Frontend Module
- **City Grid Visualization**: A procedural Manhattan-style grid rendering residential blocks, commercial zones, parks (like Central Park), and waterways.
- **Real-Time Entity Rendering**: Beautiful, highly-detailed top-down vector SVGs for Drivers (Green = Available, Slate = Busy) and teardrop pins for Riders.
- **Anti-Clutter Logic**: Deterministic micro-offsets prevent driver icons from perfectly overlapping when in the same intersection.
- **Live Activity Feed**: Real-time event stream showing driver-to-rider matches, ETAs, and surge-adjusted fares.
- **Mock Simulator**: Includes a fully self-contained JS mock simulation to demonstrate frontend capabilities without a connected backend.

### ⚙️ Backend Module (C++ Core)
- **Multi-threaded Simulation**: Utilizes `std::thread` and `std::mutex` to spawn independent concurrent threads for each driver.
- **Thread-safe Entity Management**: Defines robust `Driver` and `Rider` structs, securely updating shared memory state within a randomized coordinate grid.
- **Safe I/O**: Implements a dedicated console mutex for synchronized, timestamped logging across multiple concurrent threads.

## 📂 Project Structure

```text
RideSync/
├── frontend/
│   ├── index.html    # Main dashboard layout
│   ├── styles.css    # Modern UI tokens, responsive grids, animations
│   └── app.js        # Canvas rendering, polling logic, local simulation
└── backend/
    ├── main.cpp      # C++ Multithreaded Driver Simulation
    └── sim           # Compiled binary (Ignored in Git)
```

## 🚀 Getting Started

### Running the Frontend Dashboard
Because browsers block direct file access due to CORS policies, serve the frontend using a local web server:

```bash
# From the project root
cd frontend
python3 -m http.server 8080
```
Then visit `http://localhost:8080` in your browser.

### Compiling and Running the Backend
The backend utilizes C++17 threading features. Compile it using `clang++` or `g++`:

```bash
# From the project root
cd backend
clang++ -std=c++17 -pthread main.cpp -o sim
./sim
```

## 🗺️ Roadmap
- [x] Step 1: Build the frontend visualization dashboard.
- [x] Step 2: Initialize the multi-threaded C++ backend with basic driver movement.
- [ ] Step 3: Implement Rider matching logic in C++.
- [ ] Step 4: Add Surge Pricing heatmap generation in C++.
- [ ] Step 5: Connect the Frontend and Backend via a local HTTP API.
