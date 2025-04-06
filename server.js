const express = require("express");
const cors = require("cors");
const session = require("express-session");
const db = require("./database"); // Needs to be a Pool object

const app = express();
const PORT = 3000;

app.use(cors({
    origin: "http://127.0.0.1:5500",
    methods: ["GET", "POST"],
    credentials: true
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(session({
    secret: "your-secret-key",
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: false,
        httpOnly: true,
        maxAge: 1000 * 60 * 60,
        sameSite: 'Lax'
    }
}));

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

app.get('/', (req, res) => {
    if (req.session.user) {
        if (req.session.user.residing_status === "Hosteller") {
            res.redirect('/Homepage.html');
        } else if (req.session.user.residing_status === "Day Scholar") {
            res.redirect('/Homepage1.html');
        } else {
            console.warn("Unknown residing status for logged-in user:", req.session.user.rollno);
            res.redirect('/login.html');
        }
    } else {
        res.redirect('/login.html');
    }
});

app.use(express.static(__dirname));

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
            console.error("❌ Database error (user fetch):", err);
            return res.status(500).json({ success: false, message: "Database error" });
        }

        if (userResults.length === 0) {
            return res.status(401).json({ success: false, message: "Invalid credentials" });
        }

        const user = userResults[0];

        if (!user.ROOMNO || user.RESIDING_STATUS !== 'Hosteller') {
            req.session.user = {
                rollno: user.ROLLNO,
                name: user.NAME,
                residing_status: user.RESIDING_STATUS,
                roomno: user.ROOMNO,
                roommates: [],
                appliances: []
            };
            req.session.save((err) => {
                if (err) {
                    console.error("❌ Session save error (no room/day scholar):", err);
                    return res.status(500).json({ success: false, message: "Session save error" });
                }
                res.json({
                    success: true,
                    message: `Login successful (${user.RESIDING_STATUS || 'Status Unknown'})`,
                    user: req.session.user
                });
            });
            return;
        }

        const currentRoomNo = user.ROOMNO;

        const roommateQuery = `
            SELECT s.ROLLNO, s.NAME, s.RESIDING_STATUS
            FROM student s
            JOIN room_allotment ra ON s.ROLLNO = ra.ROLLNO
            WHERE ra.ROOMNO = ? AND s.ROLLNO != ?`;

        db.query(roommateQuery, [currentRoomNo, user.ROLLNO], (err, roommates) => {
            if (err) {
                console.error("❌ Roommate fetch error:", err);
                return res.status(500).json({ success: false, message: "Database error (roommates)" });
            }

            const applianceQuery = `
                SELECT a.appliance_id, a.name, ra.count AS count
                FROM room_appliance ra
                JOIN appliances a ON ra.appliance_id = a.appliance_id
                WHERE ra.roomno = ?`;

            db.query(applianceQuery, [currentRoomNo], (err, appliances) => {
                if (err) {
                    console.error("❌ Appliance fetch error:", err);
                    return res.status(500).json({ success: false, message: "Database error (appliances)" });
                }

                const totalAppliances = Array.isArray(appliances) ? appliances : [];

                 const reportedCountsSql = `
                      SELECT qa.appliance_id, SUM(qa.count) as reported_count
                      FROM query q
                      JOIN query_appliances qa ON q.QUERY_ID = qa.query_id
                      WHERE q.roomno = ?
                        AND q.status = 'not done'
                      GROUP BY qa.appliance_id;
                 `;

                 db.query(reportedCountsSql, [currentRoomNo], (err, reportedResults) => {
                      if (err) {
                           console.error("❌ Reported counts fetch error:", err);
                           return res.status(500).json({ success: false, message: "Database error (reported counts)" });
                      }

                      const reportedCountsMap = {};
                      if (Array.isArray(reportedResults)) {
                           reportedResults.forEach(row => {
                                reportedCountsMap[row.appliance_id] = row.reported_count;
                           });
                      }
                      console.log(`ℹ️ Reported counts for room ${currentRoomNo}:`, reportedCountsMap);

                      const enhancedAppliances = totalAppliances.map(app => {
                           const reportedCount = reportedCountsMap[app.appliance_id] || 0;
                           return {
                                appliance_id: app.appliance_id,
                                name: app.name,
                                count: app.count,
                                reportedCount: reportedCount
                           };
                      });

                      req.session.user = {
                           rollno: user.ROLLNO,
                           name: user.NAME,
                           residing_status: user.RESIDING_STATUS,
                           roomno: currentRoomNo,
                           roommates: roommates || [],
                           appliances: enhancedAppliances
                      };

                      req.session.save((err) => {
                           if (err) {
                                console.error("❌ Session save error (hosteller):", err);
                                return res.status(500).json({ success: false, message: "Session save error" });
                           }

                           console.log("✅ Login successful, user session created:", req.session.user);
                           res.json({
                                success: true,
                                message: "Login successful",
                                user: req.session.user
                           });
                      });
                 });
            });
        });
    });
});

app.get("/user", (req, res) => {
    if (!req.session.user) {
        return res.status(401).json({ success: false, message: "Not logged in" });
    }
    res.json({ success: true, user: req.session.user });
});

// --- Using Manual JS ID Calculation + Pre-Check + Update Return ---
app.post("/submitQuery", (req, res) => {
    const { rollno, roomno, description, appliances } = req.body;

    console.log("🚀 Received /submitQuery request:", { rollno, roomno, description, appliances });

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
            console.warn(`⚠️ Attempt to submit duplicate query for Room: ${roomno}, Appliance: ${existingAppName}`);
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
            console.log("ℹ️ Database connection acquired for transaction.");

            connection.beginTransaction(err => {
                if (err) {
                    console.error("❌ Error beginning transaction:", err);
                    connection.release();
                    return res.status(500).json({ success: false, message: "Failed to start database transaction." });
                }
                console.log("BEGIN TRANSACTION");

                const getNextQueryIdSql = `SELECT IFNULL(MAX(QUERY_ID), 0) + 1 AS nextId FROM query`;
                connection.query(getNextQueryIdSql, (err, result) => {
                    if (err) {
                        console.error("❌ Error fetching next QUERY_ID:", err);
                        return connection.rollback(() => {
                            console.log("ROLLBACK: Error fetching next QUERY_ID");
                            connection.release();
                            res.status(500).json({ success: false, message: "Error getting next query ID." });
                        });
                    }

                    const queryId = result[0].nextId;
                    console.log(`ℹ️ Manually calculated QUERY_ID: ${queryId}`);

                    const insertQuerySql = `INSERT INTO query (QUERY_ID, roomno, ROLLNO, description, status) VALUES (?, ?, ?, ?, 'not done')`;
                    const queryValues = [queryId, roomno, rollno, description];

                    connection.query(insertQuerySql, queryValues, (err, queryResult) => {
                        if (err) {
                            console.error("❌ Error inserting into query table:", err);
                            return connection.rollback(() => {
                                console.log("ROLLBACK: Error inserting into query table");
                                connection.release();
                                res.status(500).json({ success: false, message: "Query insert failed.", detail: err.code || err.message });
                            });
                        }
                        console.log(`✅ Inserted into 'query' table. Rows affected: ${queryResult.affectedRows}`);

                        const queryApplianceSql = `INSERT INTO query_appliances (query_id, appliance_id, count) VALUES ?`;
                        const applianceInsertValues = appliances.map(appl => [queryId, appl.appliance_id, appl.count]);

                        connection.query(queryApplianceSql, [applianceInsertValues], (err, applianceResult) => {
                            if (err) {
                                console.error("❌ Database error during query_appliances insert:", err);
                                console.error("❌ Failed values array for query_appliances:", JSON.stringify(applianceInsertValues, null, 2));
                                return connection.rollback(() => {
                                    console.log("ROLLBACK: Error inserting into query_appliances table");
                                    connection.release();
                                    res.status(500).json({ success: false, message: "Appliance details insert failed.", detail: err.code || err.message });
                                });
                            }
                            console.log(`✅ Inserted into 'query_appliances' table. Rows affected: ${applianceResult.affectedRows}`);

                            connection.commit(async err => { // Make commit callback async to use await inside
                                if (err) {
                                    console.error("❌ Error committing transaction:", err);
                                    return connection.rollback(() => {
                                        console.log("ROLLBACK: Error committing transaction");
                                        connection.release();
                                        res.status(500).json({ success: false, message: "Failed to commit transaction.", detail: err.code || err.message });
                                    });
                                }
                                console.log("COMMIT successful.");
                                connection.release(); // Release connection after commit

                                try {
                                    console.log(`ℹ️ Re-fetching appliance data for room ${roomno} after successful query submission.`);
                                    const updatedEnhancedAppliances = await getEnhancedAppliances(roomno, db); // Use pool `db` here

                                    const currentUserSessionData = req.session.user || {};
                                    const updatedUserObject = {
                                        ...currentUserSessionData,
                                        rollno: rollno,
                                        roomno: roomno,
                                        appliances: updatedEnhancedAppliances
                                    };

                                    console.log("✅ Query submitted successfully. Sending updated user data. Query ID:", queryId);
                                    res.json({
                                        success: true,
                                        message: "Query submitted successfully!",
                                        queryId: queryId,
                                        user: updatedUserObject
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


app.post("/logout", (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            return res.status(500).json({ success: false, message: "Logout failed" });
        }
        res.clearCookie("connect.sid");
        res.json({ success: true, message: "Logged out successfully" });
    });
});

app.use((req, res) => {
    res.status(404).json({ success: false, message: "Route not found" });
});

app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
});