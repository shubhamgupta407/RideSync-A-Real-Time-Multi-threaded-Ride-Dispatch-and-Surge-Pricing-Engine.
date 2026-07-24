#include <iostream>
#include <vector>
#include <thread>
#include <chrono>
#include <random>
#include <mutex>
#include <string>
#include <iomanip>
#include <ctime>
#include <sstream>
#include <queue>
#include <condition_variable>
#include <cmath>
#include <atomic>
#include <map>
#include <deque>

// Use single-header libraries for HTTP and JSON
#include "httplib.h"
#include "json.hpp"

using json = nlohmann::json;

// Config option (set to false for bounded console runs)
const bool RUN_INDEFINITELY = true;

// Status Enum
enum class DriverStatus {
    AVAILABLE,
    BUSY
};

// Driver Struct
struct Driver {
    std::string id;
    int x;
    int y;
    DriverStatus status;
};

// RideRequest Struct
struct RideRequest {
    std::string rider_id;
    int pickup_x;
    int pickup_y;
    int drop_x;
    int drop_y;
    std::string timestamp;
};

// Match Record for JSON endpoint
struct MatchRecord {
    std::string driver_id;
    std::string rider_id;
    double eta_min;
    double fare;
    double surge_multiplier;
    std::string timestamp;
};

// Mutexes & Shared State
std::mutex console_mutex;
std::mutex driver_mutex;
std::mutex zone_mutex; 
std::mutex pending_riders_mutex;
std::mutex matches_mutex;

std::map<int, int> pending_requests_per_zone;
std::vector<RideRequest> pending_riders;
std::deque<MatchRecord> recent_matches;
std::atomic<int> rides_matched_total(0);
std::atomic<bool> simulation_running(true);

// Helper to get current timestamp
std::string getCurrentTimestamp() {
    auto now = std::chrono::system_clock::now();
    std::time_t now_time = std::chrono::system_clock::to_time_t(now);
    std::tm tm_struct;
    localtime_r(&now_time, &tm_struct);
    
    std::ostringstream oss;
    oss << std::put_time(&tm_struct, "%Y-%m-%dT%H:%M:%SZ"); // ISO 8601 format
    return oss.str();
}

// Helper to determine zone
int getZoneId(int x, int y, int grid_size = 10, int num_zones = 3) {
    int zone_width = std::ceil((double)grid_size / num_zones);
    int zx = x / zone_width;
    int zy = y / zone_width;
    return zy * num_zones + zx;
}

// ------------------------------------------------------------------
// Part A: Ride Request & Thread-Safe Queue
// ------------------------------------------------------------------

class RequestQueue {
private:
    std::queue<RideRequest> queue;
    std::mutex queue_mutex;
    std::condition_variable queue_cv;

public:
    void push(const RideRequest& req) {
        std::lock_guard<std::mutex> lock(queue_mutex);
        queue.push(req);
        
        {
            std::lock_guard<std::mutex> plock(pending_riders_mutex);
            pending_riders.push_back(req);
        }
        
        queue_cv.notify_one();
    }

    bool pop(RideRequest& req) {
        std::unique_lock<std::mutex> lock(queue_mutex);
        queue_cv.wait(lock, [this]() { return !queue.empty() || !simulation_running; });
        
        if (!simulation_running && queue.empty()) {
            return false;
        }

        req = queue.front();
        queue.pop();
        
        {
            // Safely remove popped request from our JSON view tracker
            std::lock_guard<std::mutex> plock(pending_riders_mutex);
            for (auto it = pending_riders.begin(); it != pending_riders.end(); ++it) {
                if (it->rider_id == req.rider_id) {
                    pending_riders.erase(it);
                    break;
                }
            }
        }
        
        return true;
    }
    
    void shutdown() {
        queue_cv.notify_all();
    }
};

RequestQueue ride_queue;

void simulateRider(int id, int grid_size) {
    std::random_device rd;
    std::mt19937 gen(rd());
    std::uniform_int_distribution<> grid_dist(0, grid_size - 1);
    std::uniform_int_distribution<> time_dist(3000, 8000); 

    std::string rider_id = "R" + std::to_string(id);

    while (simulation_running) {
        std::this_thread::sleep_for(std::chrono::milliseconds(time_dist(gen)));
        if (!simulation_running) break;

        RideRequest req;
        req.rider_id = rider_id;
        req.pickup_x = grid_dist(gen);
        req.pickup_y = grid_dist(gen);
        req.drop_x = grid_dist(gen);
        req.drop_y = grid_dist(gen);
        req.timestamp = getCurrentTimestamp();

        ride_queue.push(req);
    }
}

// ------------------------------------------------------------------
// Dispatcher Engine
// ------------------------------------------------------------------

void dispatchEngine(std::vector<Driver>& drivers, int grid_size) {
    while (simulation_running) {
        RideRequest req;
        if (!ride_queue.pop(req)) {
            break; 
        }

        int zone_id = getZoneId(req.pickup_x, req.pickup_y, grid_size);
        
        {
            std::lock_guard<std::mutex> lock(zone_mutex);
            pending_requests_per_zone[zone_id]++;
        }

        bool driver_found = false;
        Driver* best_driver = nullptr;
        double min_dist = std::numeric_limits<double>::max();
        int available_drivers_in_zone = 0;

        {
            std::lock_guard<std::mutex> lock(driver_mutex);
            
            for (auto& d : drivers) {
                if (d.status == DriverStatus::AVAILABLE) {
                    if (getZoneId(d.x, d.y, grid_size) == zone_id) {
                        available_drivers_in_zone++;
                    }

                    double dist = std::sqrt(std::pow(d.x - req.pickup_x, 2) + std::pow(d.y - req.pickup_y, 2));
                    if (dist < min_dist) {
                        min_dist = dist;
                        best_driver = &d;
                    }
                }
            }

            if (best_driver) {
                best_driver->status = DriverStatus::BUSY;
                driver_found = true;
            }
        } 

        if (!driver_found) {
            {
                std::lock_guard<std::mutex> lock(console_mutex);
                std::cout << "[" << getCurrentTimestamp() << "] No drivers available for rider " << req.rider_id << ", will retry\n";
            }
            {
                std::lock_guard<std::mutex> lock(zone_mutex);
                pending_requests_per_zone[zone_id]--; 
            }
            std::this_thread::sleep_for(std::chrono::milliseconds(1000));
            ride_queue.push(req);
            continue;
        }

        int pending_count;
        {
            std::lock_guard<std::mutex> lock(zone_mutex);
            pending_count = pending_requests_per_zone[zone_id];
            pending_requests_per_zone[zone_id]--; 
        }

        double surge_multiplier = 1.0;
        int difference = pending_count - available_drivers_in_zone;
        if (difference >= 3) {
            surge_multiplier = 2.0;
        } else if (difference >= 1) {
            surge_multiplier = 1.5;
        }

        double base_fare = 5.0;
        double per_unit_rate = 2.0;
        double fare = (base_fare + min_dist * per_unit_rate) * surge_multiplier;

        {
            std::lock_guard<std::mutex> lock(console_mutex);
            std::cout << "[" << getCurrentTimestamp() << "] Match: " << best_driver->id << " assigned to " << req.rider_id 
                      << " | Dist: " << std::fixed << std::setprecision(2) << min_dist 
                      << " | Fare: $" << fare;
            if (surge_multiplier > 1.0) std::cout << " (Surge " << surge_multiplier << "x)";
            std::cout << "\n";
        }
        
        rides_matched_total++;

        {
            std::lock_guard<std::mutex> lock(matches_mutex);
            MatchRecord record {
                best_driver->id,
                req.rider_id,
                min_dist, 
                fare,
                surge_multiplier,
                getCurrentTimestamp()
            };
            recent_matches.push_front(record);
            if (recent_matches.size() > 20) {
                recent_matches.pop_back();
            }
        }

        /*
         * (a) How the dispatcher fix keeps it non-blocking:
         * Previously, the dispatcher thread itself might sleep to simulate the ride. Now, we spawn a 
         * lightweight detached std::thread whose ONLY job is to sleep for 4 seconds and then safely 
         * restore the driver to AVAILABLE. The dispatcher immediately loops back to `pop()` the next 
         * request, remaining highly responsive and never getting stuck waiting for a ride to finish.
         */
        std::thread([best_driver]() {
            std::this_thread::sleep_for(std::chrono::seconds(4)); 
            if (simulation_running) {
                std::lock_guard<std::mutex> lock(driver_mutex);
                best_driver->status = DriverStatus::AVAILABLE;
            }
        }).detach();
    }
}

// ------------------------------------------------------------------
// Driver Simulation
// ------------------------------------------------------------------
void simulateDriver(Driver& driver, int grid_size) {
    std::random_device rd;
    std::mt19937 gen(rd());
    std::uniform_int_distribution<> grid_dist(0, grid_size - 1);
    std::uniform_int_distribution<> time_dist(1000, 2000); 

    while (simulation_running) {
        std::this_thread::sleep_for(std::chrono::milliseconds(time_dist(gen)));
        if (!simulation_running) break;

        {
            std::lock_guard<std::mutex> lock(driver_mutex);
            if (driver.status == DriverStatus::AVAILABLE) {
                driver.x = grid_dist(gen);
                driver.y = grid_dist(gen);
            }
        }
    }
}

// ------------------------------------------------------------------
// Part B: HTTP Server 
// ------------------------------------------------------------------

json getStateJson(const std::vector<Driver>& drivers, int grid_size) {
    json state;
    state["stats"] = json::object();
    state["drivers"] = json::array();
    state["riders"] = json::array();
    state["surge_zones"] = json::array();
    state["recent_matches"] = json::array();

    int active_drivers = 0;
    
    {
        std::lock_guard<std::mutex> lock(driver_mutex);
        for (const auto& d : drivers) {
            if (d.status == DriverStatus::AVAILABLE) active_drivers++;
            
            json driver_json;
            driver_json["id"] = d.id;
            driver_json["x"] = d.x;
            driver_json["y"] = d.y;
            driver_json["status"] = (d.status == DriverStatus::AVAILABLE) ? "available" : "busy";
            driver_json["heading_deg"] = 0; // Simplified for now per requirements
            state["drivers"].push_back(driver_json);
        }
    }
    
    state["stats"]["active_drivers"] = active_drivers;
    state["stats"]["rides_matched_total"] = rides_matched_total.load();
    
    {
        std::lock_guard<std::mutex> lock(pending_riders_mutex);
        state["stats"]["pending_requests"] = pending_riders.size();
        for (const auto& r : pending_riders) {
            json rider_json;
            rider_json["id"] = r.rider_id;
            rider_json["x"] = r.pickup_x;
            rider_json["y"] = r.pickup_y;
            state["riders"].push_back(rider_json);
        }
    }
    
    int active_surge_zones = 0;
    for (int z = 0; z < 9; ++z) {
        int pending_in_zone = 0;
        {
            std::lock_guard<std::mutex> lock(zone_mutex);
            pending_in_zone = pending_requests_per_zone[z];
        }
        
        int available_in_zone = 0;
        {
            std::lock_guard<std::mutex> lock(driver_mutex);
            for (const auto& d : drivers) {
                if (d.status == DriverStatus::AVAILABLE && getZoneId(d.x, d.y, grid_size) == z) {
                    available_in_zone++;
                }
            }
        }
        
        int diff = pending_in_zone - available_in_zone;
        double surge = 1.0;
        if (diff >= 3) surge = 2.0;
        else if (diff >= 1) surge = 1.5;
        
        if (surge > 1.0) {
            active_surge_zones++;
            
            int num_zones = 3;
            int zone_width = std::ceil((double)grid_size / num_zones); 
            int zx = z % num_zones;
            int zy = z / num_zones;
            
            json zone_json;
            zone_json["x_min"] = zx * zone_width;
            zone_json["y_min"] = zy * zone_width;
            zone_json["x_max"] = std::min((zx + 1) * zone_width - 1, grid_size - 1);
            zone_json["y_max"] = std::min((zy + 1) * zone_width - 1, grid_size - 1);
            zone_json["multiplier"] = surge;
            
            state["surge_zones"].push_back(zone_json);
        }
    }
    state["stats"]["surge_zones_active"] = active_surge_zones;
    
    {
        std::lock_guard<std::mutex> lock(matches_mutex);
        for (const auto& m : recent_matches) {
            json m_json;
            m_json["driver_id"] = m.driver_id;
            m_json["rider_id"] = m.rider_id;
            m_json["eta_min"] = m.eta_min;
            m_json["fare"] = m.fare;
            m_json["surge_multiplier"] = m.surge_multiplier;
            m_json["timestamp"] = m.timestamp;
            state["recent_matches"].push_back(m_json);
        }
    }

    return state;
}

/*
 * (b) Why the HTTP server runs on a separate thread:
 * The HTTP server contains a blocking `.listen()` loop that waits indefinitely for incoming network 
 * requests. If it ran on the main thread or dispatcher thread, it would halt the entire simulation. 
 * By giving it its own dedicated thread, it can asynchronously receive REST API calls while the 
 * C++ ride matching simulation continues processing at full speed in the background.
 *
 * (c) How JSON is assembled safely:
 * Since multiple threads (drivers, riders, dispatcher) are constantly mutating state, the HTTP 
 * server thread quickly locks specific mutexes (`driver_mutex`, `pending_riders_mutex`, `matches_mutex`)
 * just long enough to copy the data into the JSON object. This ensures we never read half-written structs 
 * or crash from a vector re-allocating memory during a read.
 */
void runHttpServer(std::vector<Driver>& drivers, int grid_size) {
    httplib::Server svr;
    
    svr.Get("/state", [&drivers, grid_size](const httplib::Request& req, httplib::Response& res) {
        json state = getStateJson(drivers, grid_size);
        res.set_header("Access-Control-Allow-Origin", "*");
        res.set_content(state.dump(), "application/json");
    });
    
    {
        std::lock_guard<std::mutex> lock(console_mutex);
        std::cout << "[HTTP] Server active on http://0.0.0.0:8080/state\n";
    }
    svr.listen("0.0.0.0", 8080);
}


// ------------------------------------------------------------------
// Main
// ------------------------------------------------------------------
int main() {
    const int NUM_DRIVERS = 5;
    const int NUM_RIDERS = 8; 
    const int GRID_SIZE = 10;
    const int SIMULATION_DURATION_SECONDS = 30; 

    std::vector<Driver> drivers;
    std::vector<std::thread> driver_threads;
    std::vector<std::thread> rider_threads;

    for (int i = 0; i < NUM_DRIVERS; ++i) {
        drivers.push_back({"D" + std::to_string(i + 1), 0, 0, DriverStatus::AVAILABLE});
    }

    std::cout << "Starting RideSync Multi-threaded Dispatch Engine...\n";
    
    // Spawn driver threads
    for (int i = 0; i < NUM_DRIVERS; ++i) {
        driver_threads.emplace_back(simulateDriver, std::ref(drivers[i]), GRID_SIZE);
    }

    // Spawn rider threads
    for (int i = 0; i < NUM_RIDERS; ++i) {
        rider_threads.emplace_back(simulateRider, i + 1, GRID_SIZE);
    }

    // Spawn dispatcher thread
    std::thread dispatcher_thread(dispatchEngine, std::ref(drivers), GRID_SIZE);

    // Spawn HTTP Server thread
    std::thread http_thread(runHttpServer, std::ref(drivers), GRID_SIZE);

    if (RUN_INDEFINITELY) {
        std::cout << "Running indefinitely for live frontend testing (Press Ctrl+C to stop)...\n\n";
        http_thread.join(); // Blocks forever unless listen() fails

        std::cout << "\nHTTP server stopped. Shutting down simulation cleanly...\n";
        simulation_running = false;
        ride_queue.shutdown(); 

        for (auto& t : driver_threads) {
            if (t.joinable()) t.join();
        }
        for (auto& t : rider_threads) {
            if (t.joinable()) t.join();
        }
        if (dispatcher_thread.joinable()) {
            dispatcher_thread.join();
        }
        std::cout << "Simulation Complete. All threads finished safely.\n";
    } else {
        std::cout << "Running for " << SIMULATION_DURATION_SECONDS << " seconds...\n\n";
        std::this_thread::sleep_for(std::chrono::seconds(SIMULATION_DURATION_SECONDS));

        std::cout << "\nTimer complete. Shutting down simulation cleanly...\n";
        simulation_running = false;
        ride_queue.shutdown(); 

        for (auto& t : driver_threads) {
            if (t.joinable()) t.join();
        }
        for (auto& t : rider_threads) {
            if (t.joinable()) t.join();
        }
        if (dispatcher_thread.joinable()) {
            dispatcher_thread.join();
        }
        std::cout << "Simulation Complete. All threads finished safely.\n";
        exit(0); 
    }

    return 0;
}
