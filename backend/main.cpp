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

// Original Rider Struct (kept for compatibility)
struct Rider {
    std::string id;
    int pickup_x;
    int pickup_y;
    int drop_x;
    int drop_y;
};

// Mutexes
std::mutex console_mutex;
std::mutex driver_mutex;

// Atomic flag for clean shutdown of all threads
std::atomic<bool> simulation_running(true);

// Helper to get current timestamp string safely
std::string getCurrentTimestamp() {
    auto now = std::chrono::system_clock::now();
    std::time_t now_time = std::chrono::system_clock::to_time_t(now);
    std::tm tm_struct;
    localtime_r(&now_time, &tm_struct);
    
    std::ostringstream oss;
    oss << std::put_time(&tm_struct, "%Y-%m-%d %H:%M:%S");
    return oss.str();
}

// ------------------------------------------------------------------
// Part A: Ride Request & Thread-Safe Queue
// ------------------------------------------------------------------

struct RideRequest {
    std::string rider_id;
    int pickup_x;
    int pickup_y;
    int drop_x;
    int drop_y;
    std::string timestamp;
};

/*
 * (a) Why condition_variable avoids busy-waiting:
 * If a dispatcher thread repeatedly checks a while(!queue.empty()) loop, it will "busy-wait" 
 * and consume nearly 100% of a CPU core doing nothing but checking an empty queue. 
 * A std::condition_variable puts the thread completely to sleep (consuming 0% CPU) until 
 * another thread explicitly wakes it up (via notify_one) when new data is actually available.
 */
class RequestQueue {
private:
    std::queue<RideRequest> queue;
    std::mutex queue_mutex;
    std::condition_variable queue_cv;

public:
    void push(const RideRequest& req) {
        std::lock_guard<std::mutex> lock(queue_mutex);
        queue.push(req);
        queue_cv.notify_one(); // Wake up the dispatcher
    }

    bool pop(RideRequest& req) {
        std::unique_lock<std::mutex> lock(queue_mutex);
        // Wait until queue is not empty OR simulation is shutting down
        queue_cv.wait(lock, [this]() { return !queue.empty() || !simulation_running; });
        
        if (!simulation_running && queue.empty()) {
            return false;
        }

        req = queue.front();
        queue.pop();
        return true;
    }
    
    // Wake up sleeping threads during shutdown
    void shutdown() {
        queue_cv.notify_all();
    }
};

RequestQueue ride_queue;

// Rider simulation thread
void simulateRider(int id, int grid_size) {
    std::random_device rd;
    std::mt19937 gen(rd());
    std::uniform_int_distribution<> grid_dist(0, grid_size - 1);
    std::uniform_int_distribution<> time_dist(3000, 8000); // 3 to 8 seconds

    std::string rider_id = "R" + std::to_string(id);

    while (simulation_running) {
        // Sleep for a random duration before requesting a ride
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
// Part B: Matching Engine & Surge Pricing
// ------------------------------------------------------------------

// Helper to determine zone (e.g. 3x3 zones in a 10x10 grid means 4x4 blocks per zone)
int getZoneId(int x, int y, int grid_size = 10, int num_zones = 3) {
    int zone_width = std::ceil((double)grid_size / num_zones);
    int zx = x / zone_width;
    int zy = y / zone_width;
    return zy * num_zones + zx;
}

// Map to track pending requests per zone
std::map<int, int> pending_requests_per_zone;
std::mutex zone_mutex; 

void dispatchEngine(std::vector<Driver>& drivers, int grid_size) {
    while (simulation_running) {
        RideRequest req;
        if (!ride_queue.pop(req)) {
            break; // Shutdown signal received and queue empty
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

        /*
         * (b) Why driver_mutex is locked during the nearest-driver search and status update:
         * We lock the driver_mutex across the ENTIRE read-calculate-update cycle to prevent race conditions.
         * If we didn't lock it, a driver simulation thread could move the driver's (x,y) while we calculate 
         * distance, or another process could mark the driver BUSY right before we do. Locking guarantees 
         * we evaluate the current state and secure the driver atomically.
         */
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
        } // release driver_mutex

        if (!driver_found) {
            {
                std::lock_guard<std::mutex> lock(console_mutex);
                std::cout << "[" << getCurrentTimestamp() << "] No drivers available for rider " << req.rider_id << ", will retry\n";
            }
            {
                std::lock_guard<std::mutex> lock(zone_mutex);
                pending_requests_per_zone[zone_id]--; // Remove from pending since we're pushing it back
            }
            // Delay before re-queueing to prevent thrashing
            std::this_thread::sleep_for(std::chrono::milliseconds(1000));
            ride_queue.push(req);
            continue;
        }

        // --- Driver found! Proceed to Surge Pricing & Dispatch ---
        
        int pending_count;
        {
            std::lock_guard<std::mutex> lock(zone_mutex);
            pending_count = pending_requests_per_zone[zone_id];
            pending_requests_per_zone[zone_id]--; // Request is now handled
        }

        /*
         * (c) How the surge multiplier is calculated:
         * Surge is calculated locally per geographic zone by comparing real-time demand (pending_requests) 
         * against supply (available_drivers). If demand exceeds supply by 3+, the multiplier hits 2.0x. 
         * If it exceeds by 1-2, it's 1.5x. This dynamically incentivizes drivers to move to busy zones.
         */
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

        // TODO: Detached thread to simulate the ride. 
        // When HTTP Server is added, this should be a non-blocking asynchronous callback or event queue.
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
// Driver Simulation (Legacy / Unchanged Architecture)
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
            // Only wander if available
            if (driver.status == DriverStatus::AVAILABLE) {
                driver.x = grid_dist(gen);
                driver.y = grid_dist(gen);
            }
        }
    }
}

// ------------------------------------------------------------------
// Main Execution
// ------------------------------------------------------------------
int main() {
    const int NUM_DRIVERS = 5;
    const int NUM_RIDERS = 8; // More riders than drivers to trigger surge
    const int GRID_SIZE = 10;
    const int SIMULATION_DURATION_SECONDS = 30; // Bounded demo

    std::vector<Driver> drivers;
    std::vector<std::thread> driver_threads;
    std::vector<std::thread> rider_threads;

    for (int i = 0; i < NUM_DRIVERS; ++i) {
        drivers.push_back({"D" + std::to_string(i + 1), 0, 0, DriverStatus::AVAILABLE});
    }

    std::cout << "Starting RideSync Multi-threaded Dispatch Engine...\n";
    std::cout << "Running for " << SIMULATION_DURATION_SECONDS << " seconds.\n\n";

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

    // Run for bounded duration
    std::this_thread::sleep_for(std::chrono::seconds(SIMULATION_DURATION_SECONDS));

    // Clean Shutdown
    std::cout << "\nTimer complete. Shutting down simulation cleanly...\n";
    simulation_running = false;
    ride_queue.shutdown(); // Wake up blocked dispatcher

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
    return 0;
}
