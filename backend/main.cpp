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

// Rider Struct
struct Rider {
    std::string id;
    int pickup_x;
    int pickup_y;
    int drop_x;
    int drop_y;
};

// Mutex for thread-safe console printing
std::mutex console_mutex;
// Mutex for protecting shared driver data
std::mutex driver_mutex;

// Helper to get current timestamp string safely
std::string getCurrentTimestamp() {
    auto now = std::chrono::system_clock::now();
    std::time_t now_time = std::chrono::system_clock::to_time_t(now);
    std::tm tm_struct;
    
    // localtime_r is thread-safe on POSIX systems (macOS, Linux)
    localtime_r(&now_time, &tm_struct);
    
    std::ostringstream oss;
    oss << std::put_time(&tm_struct, "%Y-%m-%d %H:%M:%S");
    return oss.str();
}

// Driver simulation function to run in a thread
void simulateDriver(Driver& driver, int grid_size, int num_updates) {
    // Thread-local random engine
    std::random_device rd;
    std::mt19937 gen(rd());
    std::uniform_int_distribution<> grid_dist(0, grid_size - 1);
    std::uniform_int_distribution<> time_dist(1000, 2000); // 1 to 2 seconds

    for (int i = 0; i < num_updates; ++i) {
        // Sleep for 1-2 seconds
        std::this_thread::sleep_for(std::chrono::milliseconds(time_dist(gen)));

        // Update driver position safely
        {
            std::lock_guard<std::mutex> lock(driver_mutex);
            driver.x = grid_dist(gen);
            driver.y = grid_dist(gen);
        }

        // Print update safely to console
        {
            std::lock_guard<std::mutex> lock(console_mutex);
            std::cout << "[" << getCurrentTimestamp() << "] "
                      << "Driver " << driver.id 
                      << " moved to (" << driver.x << ", " << driver.y << ")\n";
        }
    }
}

int main() {
    const int NUM_DRIVERS = 5;
    const int GRID_SIZE = 10;
    const int UPDATES_PER_DRIVER = 5;

    std::vector<Driver> drivers;
    std::vector<std::thread> driver_threads;

    // Initialize drivers
    for (int i = 0; i < NUM_DRIVERS; ++i) {
        drivers.push_back({"D" + std::to_string(i + 1), 0, 0, DriverStatus::AVAILABLE});
    }

    std::cout << "Starting RideSync Driver Simulation (C++ Backend)...\n";
    std::cout << "Grid Size: " << GRID_SIZE << "x" << GRID_SIZE << "\n";
    std::cout << "Number of Drivers: " << NUM_DRIVERS << "\n\n";

    // Spawn threads
    for (int i = 0; i < NUM_DRIVERS; ++i) {
        // Pass the driver by reference to the thread function
        driver_threads.emplace_back(simulateDriver, std::ref(drivers[i]), GRID_SIZE, UPDATES_PER_DRIVER);
    }

    // Join threads to wait for all of them to finish
    for (auto& t : driver_threads) {
        if (t.joinable()) {
            t.join();
        }
    }

    std::cout << "\nSimulation Complete. All threads finished.\n";
    return 0;
}
