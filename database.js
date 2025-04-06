// database.js
const mysql = require("mysql2"); // Using mysql2 is good

// Database connection details (keep your existing details)
const dbConfig = {
    host: "10.7.99.214",
    port: 3306,           // Port is often optional if default 3306
    user: "dbmsuser",
    password: "dbmsproject",
    database: "dbms_project",
    waitForConnections: true, // Recommended pool setting
    connectionLimit: 10,      // Default/Example limit, adjust if needed
    queueLimit: 0             // Default: no limit on queued requests
};

// Create a connection POOL instead of a single connection
const pool = mysql.createPool(dbConfig);

// You DON'T need pool.connect() here.
// The pool handles connections automatically when you call pool.getConnection() or pool.query()

// Check if pool creation itself had an immediate issue (optional but good practice)
// Note: This doesn't guarantee connections will always work later.
pool.getConnection((err, connection) => {
    if (err) {
        console.error("❌ Database Pool Creation Error or Initial Connection Failed:", err.message);
        // Consider exiting the app if the pool can't even be initialized
        // process.exit(1);
    } else {
        console.log("✅ Database Pool created & initial connection successful!");
        connection.release(); // IMPORTANT: Release the test connection back to the pool
    }
});


// Export the POOL object for use in other files
module.exports = pool;