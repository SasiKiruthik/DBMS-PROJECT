// server.js (Updated)

const express = require("express");
const cors = require("cors");
const session = require("express-session");
const db = require("./database"); // Assume db pool is ready after this line

const app = express();
const PORT = 3000;

// --- Middleware Setup ---
app.use(cors({
    origin: "http://127.0.0.1:5500",
    methods: ["GET", "POST"],
    credentials: true
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
    secret: "your-staff-secret-key",
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: false,
        httpOnly: true,
        maxAge: 1000 * 60 * 60 * 2,
        sameSite: 'Lax'
    }
}));

// --- Helper Function ---
// (Keep your getEnhancedAppliances function here)
async function getEnhancedAppliances(roomNo, dbPool) {
    const promisePool = dbPool.promise();
    try {
        const applianceQuery = `
            SELECT a.appliance_id, a.name, ra.count AS count
            FROM room_appliance ra
            JOIN appliances a ON ra.appliance_id = a.appliance_id
            WHERE ra.roomno = ?`;
        const [totalAppliances] = await promisePool.query(applianceQuery, [roomNo]);

        const reportedCountsSql = `
            SELECT qa.appliance_id, SUM(qa.count) as reported_count
            FROM query q
            JOIN query_appliances qa ON q.QUERY_ID = qa.query_id
            WHERE q.roomno = ? AND q.status = 'not done'
            GROUP BY qa.appliance_id;`;
        const [reportedResults] = await promisePool.query(reportedCountsSql, [roomNo]);

        const reportedCountsMap = {};
        if (Array.isArray(reportedResults)) {
            reportedResults.forEach(row => {
                reportedCountsMap[row.appliance_id] = row.reported_count;
            });
        }

        const enhancedAppliances = (Array.isArray(totalAppliances) ? totalAppliances : []).map(app => {
            const reportedCount = reportedCountsMap[app.appliance_id] || 0;
            return {
                appliance_id: app.appliance_id,
                name: app.name,
                count: app.count,
                reportedCount: reportedCount
            };
        });
        return enhancedAppliances;
    } catch (error) {
        console.error(`❌ Error fetching enhanced appliances for room ${roomNo}:`, error);
        throw error;
    }
}


// --- Call Stored Procedure on Startup ---
async function runStartupProcedure() {
    try {
        if (!db || typeof db.promise !== 'function') {
             throw new Error("Database connection pool (db) or its promise() method is not available.");
        }
        const promisePool = db.promise(); // Get promise-based interface
        await promisePool.query("CALL DeleteOneByOne();");
    } catch (error) {
        console.error("❌ Error executing stored procedure 'DeleteOneByOne' during startup:", error.message);
    }
}

// Immediately call the async function during startup
// This ensures it runs once when server.js is executed
runStartupProcedure();
// --- End Procedure Call ---


// --- Route Definitions ---
app.get('/', (req, res) => {
    if (req.session.user && req.session.user.type === 'student') { // Check for student type
        if (req.session.user.residing_status === "Hosteller") {
            res.redirect('/Homepage.html');
        } else if (req.session.user.residing_status === "Day Scholar") {
            res.redirect('/Homepage1.html');
        } else {
            console.warn("Unknown residing status for logged-in student:", req.session.user.rollno);
            res.redirect('/login.html'); // Redirect students to student login
        }
    } else if (req.session.user && req.session.user.type === 'staff') { // Check for staff type
         res.redirect('/staff_dashboard.html'); // Redirect logged-in staff to their dashboard
    }
    else {
        // Default redirect can be student login or a general landing page
        res.redirect('/login.html');
    }
});

app.use(express.static(__dirname)); // Serve static files

// (Keep /login route here)
app.post("/login", (req, res) => {
    const { rollno, password } = req.body;

    if (!rollno || !password) {
        return res.status(400).json({ success: false, message: "Missing credentials" });
    }

    const userSql = `
        SELECT s.ROLLNO, s.NAME, s.RESIDING_STATUS, ra.ROOMNO
        FROM student s
        LEFT JOIN room_allotment ra ON s.ROLLNO = ra.ROLLNO
        WHERE s.ROLLNO = ? AND s.PASSWORD = ?`;

    db.query(userSql, [rollno, password], (err, userResults) => {
        if (err) {
            console.error("❌ Database error (student fetch):", err);
            return res.status(500).json({ success: false, message: "Database error" });
        }

        if (userResults.length === 0) {
            return res.status(401).json({ success: false, message: "Invalid student credentials" });
        }

        const user = userResults[0];

        // Common session setup function (to avoid repetition)
        const setupSessionAndRespond = (userData) => {
            req.session.user = { ...userData, type: 'student' }; // Add type identifier
            req.session.save((err) => {
                if (err) {
                    console.error("❌ Session save error:", err);
                    return res.status(500).json({ success: false, message: "Session save error" });
                }
                res.json({
                    success: true,
                    message: `Login successful (${user.RESIDING_STATUS || 'Status Unknown'})`,
                    user: req.session.user
                });
            });
        };

        if (user.RESIDING_STATUS !== 'Hosteller' || !user.ROOMNO) {
            // Day Scholar or Hosteller without assigned room yet
              const userData = {
                  rollno: user.ROLLNO,
                  name: user.NAME,
                  residing_status: user.RESIDING_STATUS,
                  roomno: user.ROOMNO, // Will be null or empty
                  roommates: [],
                  appliances: []
              };
            setupSessionAndRespond(userData);
            return;
        }

        // Hosteller with a room - Fetch details
        const currentRoomNo = user.ROOMNO;
        const roommateQuery = `
            SELECT s.ROLLNO, s.NAME, s.RESIDING_STATUS
            FROM student s
            JOIN room_allotment ra ON s.ROLLNO = ra.ROLLNO
            WHERE ra.ROOMNO = ? AND s.ROLLNO != ?`;

        db.query(roommateQuery, [currentRoomNo, user.ROLLNO], async (err, roommates) => { // Make callback async
            if (err) {
                console.error("❌ Roommate fetch error:", err);
                return res.status(500).json({ success: false, message: "Database error (roommates)" });
            }

            try {
                // Use the async helper function here
                const enhancedAppliances = await getEnhancedAppliances(currentRoomNo, db);

                const userData = {
                    rollno: user.ROLLNO,
                    name: user.NAME,
                    residing_status: user.RESIDING_STATUS,
                    roomno: currentRoomNo,
                    roommates: roommates || [],
                    appliances: enhancedAppliances
                };
                setupSessionAndRespond(userData);

            } catch (fetchError) {
                console.error("❌ Error fetching enhanced appliances during login:", fetchError);
                // Decide how to handle: maybe log in without appliance data or return error
                return res.status(500).json({ success: false, message: "Failed to load room details." });
            }
        });
    });
});


// (Keep /staff-login route here - with the isHostelStaff logic)
app.post("/staff-login", (req, res) => {
    const { staffId, password } = req.body;

    if (!staffId || !password) {
        return res.status(400).json({ success: false, message: "Missing Staff ID or Password" });
    }

    const staffSql = `
        SELECT LOGINID, NAME, role
        FROM staff
        WHERE LOGINID = ? AND PASSWORD = ?`;

    db.query(staffSql, [staffId, password], (err, staffResults) => {
        if (err) {
            console.error("❌ Database error (staff fetch):", err);
            return res.status(500).json({ success: false, message: "Database error during staff login" });
        }

        if (staffResults.length === 0) {
            return res.status(401).json({ success: false, message: "Invalid Staff ID or Password" });
        }

        const staff = staffResults[0];
        const isHostelStaff = !staff.LOGINID.toUpperCase().includes('C');

        req.session.user = {
            id: staff.LOGINID,
            name: staff.NAME,
            role: staff.role,
            type: 'staff',
            isHostelStaff: isHostelStaff
        };

        req.session.save((err) => {
            if (err) {
                console.error("❌ Session save error (staff):", err);
                return res.status(500).json({ success: false, message: "Session save error" });
            }
            res.json({
                success: true,
                message: "Staff login successful",
                user: req.session.user,
                redirectTo: '/staff_dashboard.html'
            });
        });
    });
});

// (Keep /user route here)
app.get("/user", (req, res) => {
    if (!req.session.user) {
        return res.status(401).json({ success: false, message: "Not logged in" });
    }
    res.json({ success: true, user: req.session.user });
});

// (Keep /submitQuery route here)
app.post("/submitQuery", (req, res) => {
    const { rollno, roomno, description, appliances } = req.body;

    if (!rollno || !roomno || !description || !Array.isArray(appliances) || appliances.length === 0) {
        return res.status(400).json({ success: false, message: "Missing or invalid required data." });
    }
    const hasInvalidAppliance = appliances.some(app => typeof app.appliance_id === 'undefined' || app.appliance_id === null || typeof app.count === 'undefined');
    if (hasInvalidAppliance) {
            return res.status(400).json({ success: false, message: "Invalid data within the appliances array." });
    }

    const submittedApplianceIds = appliances.map(app => app.appliance_id);

    const checkExistingSql = `
        SELECT DISTINCT qa.appliance_id, a.name FROM query q
        JOIN query_appliances qa ON q.QUERY_ID = qa.query_id JOIN appliances a ON qa.appliance_id = a.appliance_id
        WHERE q.roomno = ? AND q.status = 'not done' AND qa.appliance_id IN (?) LIMIT 1;`;

    db.query(checkExistingSql, [roomno, submittedApplianceIds], (err, existingResults) => {
        if (err) {
            console.error("❌ Database error during existing query check:", err);
            return res.status(500).json({ success: false, message: "Database error checking for existing queries." });
        }
        if (existingResults && existingResults.length > 0) {
            const existingAppName = existingResults[0].name;
            return res.status(409).json({
                success: false,
                message: `An unresolved query already exists for '${existingAppName}' (or another selected appliance) in this room. Please wait for staff action.`
            });
        }

        db.getConnection((err, connection) => {
            if (err) {
                console.error("❌ Error getting database connection:", err);
                return res.status(500).json({ success: false, message: "Database connection error." });
            }

            connection.beginTransaction(err => {
                if (err) {
                    console.error("❌ Error beginning transaction:", err);
                    connection.release();
                    return res.status(500).json({ success: false, message: "Failed to start database transaction." });
                }

                const getNextQueryIdSql = `SELECT IFNULL(MAX(QUERY_ID), 0) + 1 AS nextId FROM query`;
                connection.query(getNextQueryIdSql, (err, result) => {
                    if (err) {
                        console.error("❌ Error fetching next QUERY_ID:", err);
                        return connection.rollback(() => {
                            connection.release();
                            res.status(500).json({ success: false, message: "Error getting next query ID." });
                        });
                    }

                    const queryId = result[0].nextId;

                    const insertQuerySql = `INSERT INTO query (QUERY_ID, roomno, ROLLNO, description, status) VALUES (?, ?, ?, ?, 'not done')`;
                    const queryValues = [queryId, roomno, rollno, description];

                    connection.query(insertQuerySql, queryValues, (err, queryResult) => {
                        if (err) {
                            console.error("❌ Error inserting into query table:", err);
                            return connection.rollback(() => {
                                connection.release();
                                res.status(500).json({ success: false, message: "Query insert failed.", detail: err.code || err.message });
                            });
                        }

                        const queryApplianceSql = `INSERT INTO query_appliances (query_id, appliance_id, count) VALUES ?`;
                        const applianceInsertValues = appliances.map(appl => [queryId, appl.appliance_id, appl.count]);

                        connection.query(queryApplianceSql, [applianceInsertValues], (err, applianceResult) => {
                            if (err) {
                                console.error("❌ Database error during query_appliances insert:", err);
                                console.error("❌ Failed values array for query_appliances:", JSON.stringify(applianceInsertValues, null, 2));
                                return connection.rollback(() => {
                                    connection.release();
                                    res.status(500).json({ success: false, message: "Appliance details insert failed.", detail: err.code || err.message });
                                });
                            }

                            connection.commit(async err => { // Make commit callback async to use await inside
                                if (err) {
                                    console.error("❌ Error committing transaction:", err);
                                    return connection.rollback(() => {
                                        connection.release();
                                        res.status(500).json({ success: false, message: "Failed to commit transaction.", detail: err.code || err.message });
                                    });
                                }
                                connection.release(); // Release connection after commit

                                try {
                                    const updatedEnhancedAppliances = await getEnhancedAppliances(roomno, db); // Use pool `db` here

                                    // Update the session data ONLY IF the user submitting is the one logged in
                                    if (req.session.user && req.session.user.rollno === rollno) {
                                         req.session.user.appliances = updatedEnhancedAppliances;
                                         req.session.save(); // Save updated session
                                    }

                                    res.json({
                                        success: true,
                                        message: "Query submitted successfully!",
                                        queryId: queryId,
                                        // Send back the potentially updated appliance list for the *current* user
                                        user: req.session.user // Send back the possibly updated user session data
                                    });
                                } catch (fetchError) {
                                    console.error("❌ Error re-fetching user data after commit:", fetchError);
                                    // Still send success for the query submission, but maybe indicate data couldn't be refreshed
                                    res.json({
                                        success: true, // Query itself succeeded
                                        message: "Query submitted successfully, but failed to refresh user data.",
                                        queryId: queryId,
                                        user: req.session.user // Send potentially stale user data
                                    });
                                }
                            }); // End commit
                        }); // End appliance insert query
                    }); // End query insert query
                }); // End getNextQueryId query
            }); // End beginTransaction
        }); // End getConnection
    }); // End Pre-check Query
});

// (Keep /api/queries route here)
app.get("/api/queries", async (req, res) => {
    // 1. Authentication & Authorization Check
    if (!req.session.user || req.session.user.type !== 'staff') {
        return res.status(401).json({ success: false, message: "Unauthorized: Not logged in as staff." });
    }

    const isHostelStaff = req.session.user.isHostelStaff; // Get staff type from session

    try {
        // 2. Construct Base Query with Joins
        let sql = `
            SELECT
                q.QUERY_ID, q.roomno, q.ROLLNO, q.description, q.status,
                r.block_id,
                qa.appliance_id, a.name AS appliance_name, qa.count AS appliance_count
            FROM query q
            JOIN room r ON q.roomno = r.roomno
            LEFT JOIN query_appliances qa ON q.QUERY_ID = qa.query_id
            LEFT JOIN appliances a ON qa.appliance_id = a.appliance_id
            WHERE q.status = 'not done'
        `;

        // 3. Add Conditional Filtering based on Staff Type
        if (isHostelStaff) {
            sql += ` AND r.block_id IN (1, 2) `; // Hostel staff see block 1 & 2
        } else {
            sql += ` AND r.block_id NOT IN (1, 2) `; // Other staff see blocks other than 1 & 2
        }

        sql += ` ORDER BY q.QUERY_ID;`; // Order for easier processing

        // 4. Execute Query
        const promisePool = db.promise();
        const [results] = await promisePool.query(sql);

        // 5. Process Results to Group Appliances by Query ID
        const queriesMap = new Map();

        results.forEach(row => {
            if (!queriesMap.has(row.QUERY_ID)) {
                queriesMap.set(row.QUERY_ID, {
                    queryId: row.QUERY_ID,
                    roomNo: row.roomno,
                    reportedBy: row.ROLLNO,
                    description: row.description,
                    status: row.status,
                    blockId: row.block_id,
                    appliances: []
                });
            }
            if (row.appliance_id) {
                queriesMap.get(row.QUERY_ID).appliances.push({
                    id: row.appliance_id,
                    name: row.appliance_name,
                    count: row.appliance_count
                });
            }
        });

        const processedQueries = Array.from(queriesMap.values());

        // 6. Send Response
        res.json({ success: true, queries: processedQueries });

    } catch (error) {
        console.error("❌ Database error fetching queries:", error);
        res.status(500).json({ success: false, message: "Database error fetching queries." });
    }
});

// (Keep /api/queries/:queryId/complete route here)
app.post("/api/queries/:queryId/complete", async (req, res) => {
    // 1. Authentication & Authorization Check
    if (!req.session.user || req.session.user.type !== 'staff') {
        return res.status(401).json({ success: false, message: "Unauthorized: Not logged in as staff." });
    }

    const isHostelStaff = req.session.user.isHostelStaff;
    const staffId = req.session.user.id;
    const { queryId } = req.params;

    if (!queryId || isNaN(parseInt(queryId))) {
        return res.status(400).json({ success: false, message: "Invalid Query ID provided." });
    }

    const parsedQueryId = parseInt(queryId);

    try {
        const promisePool = db.promise();

        // 2. Check if the query exists, is 'not done', and belongs to the staff's scope
        const checkSql = `
            SELECT q.QUERY_ID, r.block_id
            FROM query q
            JOIN room r ON q.roomno = r.roomno
            WHERE q.QUERY_ID = ? AND q.status = 'not done'
        `;
        const [checkResults] = await promisePool.query(checkSql, [parsedQueryId]);

        if (checkResults.length === 0) {
            return res.status(404).json({ success: false, message: "Query not found or already completed." });
        }

        const queryBlockId = checkResults[0].block_id;

        // 3. Authorization Check based on block_id
        const isHostelQuery = (queryBlockId === 1 || queryBlockId === 2);

        if (isHostelStaff && !isHostelQuery) {
            console.warn(`Hostel staff ${staffId} attempting to complete non-hostel query ${parsedQueryId} (Block ${queryBlockId})`);
            return res.status(403).json({ success: false, message: "Forbidden: Hostel staff cannot complete non-hostel queries." });
        }
        if (!isHostelStaff && isHostelQuery) {
            console.warn(`Non-hostel staff ${staffId} attempting to complete hostel query ${parsedQueryId} (Block ${queryBlockId})`);
            return res.status(403).json({ success: false, message: "Forbidden: Non-hostel staff cannot complete hostel queries." });
        }

        // 4. Update the query status
        const updateSql = `UPDATE query SET status = 'done' WHERE QUERY_ID = ?`;
        const [updateResult] = await promisePool.query(updateSql, [parsedQueryId]);

        if (updateResult.affectedRows > 0) {
            res.json({ success: true, message: "Query marked as done successfully." });
        } else {
            console.warn(`Query ${parsedQueryId} was found but update affected 0 rows.`);
            res.status(500).json({ success: false, message: "Failed to update query status." });
        }

    } catch (error) {
        console.error(`❌ Database error marking query ${parsedQueryId} as done:`, error);
        res.status(500).json({ success: false, message: "Database error updating query status." });
    }
});

// --- NEW: API Endpoint to Get KP First Floor Rooms ---
app.get("/api/rooms/kpff", async (req, res) => {
    // Optional: Authentication Check (allow any logged-in user)
    if (!req.session.user) {
         return res.status(401).json({ success: false, message: "Unauthorized: Please log in." });
    }

    try {
        const sql = "SELECT roomno FROM room WHERE block_id = 4 AND floor = 1 ORDER BY roomno ASC";
        const promisePool = db.promise();
        const [results] = await promisePool.query(sql);

        // Extract just the room numbers into an array
        const roomNumbers = results.map(row => row.roomno);

        res.json({ success: true, rooms: roomNumbers });

    } catch (error) {
        console.error("❌ Database error fetching KP First Floor rooms:", error);
        res.status(500).json({ success: false, message: "Database error fetching room data." });
    }
});

// --- NEW: API Endpoint to Get KP Second Floor Rooms ---
app.get("/api/rooms/kpsf", async (req, res) => { // kpsf = KP Second Floor
    // Optional: Authentication Check (allow any logged-in user)
    if (!req.session.user) {
         return res.status(401).json({ success: false, message: "Unauthorized: Please log in." });
    }

    try {
        // --- CHANGE: Query for floor = 2 ---
        const sql = "SELECT roomno FROM room WHERE block_id = 4 AND floor = 2 ORDER BY roomno ASC";
        const promisePool = db.promise();
        const [results] = await promisePool.query(sql);

        // Extract just the room numbers into an array
        const roomNumbers = results.map(row => row.roomno);

        res.json({ success: true, rooms: roomNumbers });

    } catch (error) {
        console.error("❌ Database error fetching KP Second Floor rooms:", error);
        res.status(500).json({ success: false, message: "Database error fetching room data." });
    }
});

app.get("/api/rooms/kptf", async (req, res) => { // kptf = KP Third Floor
    // Optional: Authentication Check (allow any logged-in user)
    if (!req.session.user) {
         return res.status(401).json({ success: false, message: "Unauthorized: Please log in." });
    }

    try {
        // --- CHANGE: Query for floor = 3 ---
        const sql = "SELECT roomno FROM room WHERE block_id = 4 AND floor = 3 ORDER BY roomno ASC";
        const promisePool = db.promise();
        const [results] = await promisePool.query(sql);

        // Extract just the room numbers into an array
        const roomNumbers = results.map(row => row.roomno);

        res.json({ success: true, rooms: roomNumbers });

    } catch (error) {
        console.error("❌ Database error fetching KP Third Floor rooms:", error);
        res.status(500).json({ success: false, message: "Database error fetching room data." });
    }
});

app.get("/api/rooms/kp4f", async (req, res) => { // kp4f = KP Fourth Floor
    // Optional: Authentication Check (allow any logged-in user)
    if (!req.session.user) {
         return res.status(401).json({ success: false, message: "Unauthorized: Please log in." });
    }

    try {
        // --- CHANGE: Query for floor = 4 ---
        const sql = "SELECT roomno FROM room WHERE block_id = 4 AND floor = 4 ORDER BY roomno ASC";
        const promisePool = db.promise();
        const [results] = await promisePool.query(sql);

        // Extract just the room numbers into an array
        const roomNumbers = results.map(row => row.roomno);

        res.json({ success: true, rooms: roomNumbers });

    } catch (error) {
        console.error("❌ Database error fetching KP Fourth Floor rooms:", error);
        res.status(500).json({ success: false, message: "Database error fetching room data." });
    }
});


// (Keep /logout route here)
app.post("/logout", (req, res) => {
    const userName = req.session.user ? (req.session.user.name || req.session.user.id) : 'User';
    req.session.destroy((err) => {
        if (err) {
            console.error("❌ Logout failed:", err);
            return res.status(500).json({ success: false, message: "Logout failed" });
        }
        res.clearCookie("connect.sid");
        res.json({ success: true, message: "Logged out successfully" });
    });
});


// --- 404 Handler ---
app.use((req, res) => {
    res.status(404).json({ success: false, message: "Route not found" });
});

// --- Start Server ---
app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
});
