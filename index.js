const express = require('express')
const cors = require('cors');
const app = express();
require('dotenv').config();
const pool = require('./db');
const cron = require('node-cron');

const port = process.env.PORT || 5000;

const admin = require("firebase-admin");
const serviceAccount = require("./leave-application-firebase-adminsdk.json"); // Keep this file out of GitHub!

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

//middleware
app.use(express.json());
app.use(cors());

// verify Firebase ID Tokens
const verifyToken = async (req, res, next) => {
    const authorizationHeader = req.headers.authorization;

    if (!authorizationHeader) {
        return res.status(401).json({ message: "Unauthorized access: No token provided" });
    }

    const token = authorizationHeader.split(' ')[1];

    try {
        const decodedToken = await admin.auth().verifyIdToken(token);
        
        req.decodedUser = decodedToken;
        
        next(); 
    } catch (error) {
        console.error("Token verification failed:", error);
        return res.status(403).json({ message: "Forbidden: Invalid or expired token" });
    }
};

// Verify Chairman or Acting Chairman role
const verifyChairman = async (req, res, next) => {
    try {
        // We get the email securely from the decoded Firebase token
        const email = req.decodedUser.email;

        // Query the database to find this specific user's role
        const [rows] = await pool.execute(
            'SELECT role FROM users WHERE email = ?',
            [email]
        );

        if (rows.length === 0) {
            return res.status(403).json({ message: "Forbidden: User record not found" });
        }

        const userRole = rows[0].role;

        if (userRole === 'chairman' || userRole === 'acting_chairman') {
            next(); 
        } else {
            return res.status(403).json({ message: "Forbidden: Chairman privileges required" });
        }
    } catch (error) {
        console.error("Error in verifyChairman middleware:", error);
        return res.status(500).json({ message: "Internal server error during authorization check" });
    }
};


// --- NOTIFICATION HELPER FUNCTION ---
const createNotification = async (userEmail, eventType, themeType, message, actionUrl) => {
    try {
        const [users] = await pool.execute('SELECT id FROM users WHERE email = ?', [userEmail]);
        
        if (users.length === 0) {
            console.error('Notification Error: User not found for email:', userEmail);
            return;
        }
        
        const userId = users[0].id;

        await pool.execute(`
            INSERT INTO notifications (user_id, event_type, type, message, action_url)
            VALUES (?, ?, ?, ?, ?)
        `, [userId, eventType, themeType, message, actionUrl]);
        
    } catch (error) {
        console.error('Failed to create notification:', error);
    }
};

//-----------USER RELATED API---------------

//get users
app.get('/users', verifyToken, async(req, res)=>{
    const query = 'SELECT * FROM users';
    const [result] = await pool.execute(query);
    res.send(result);
})

// get a user's remaining leave quota
app.get('/users/quota/:email', verifyToken, async (req, res) => {
    try {
        const email = req.params.email;
        const query = 'SELECT leave_quota FROM users WHERE email = ?';
        const [rows] = await pool.execute(query, [email]);

        if (rows.length === 0) {
            return res.status(404).json({ message: 'User not found.' });
        }

        res.status(200).json({ leave_quota: rows[0].leave_quota });
    } catch (error) {
        console.error('Fetch Quota Error:', error);
        res.status(500).json({ message: 'Failed to fetch leave quota.' });
    }
});

// get user role
app.get('/users/role/:email', verifyToken, async (req, res) => {
    try {
        const email = req.params.email;
        const query = 'SELECT role FROM users WHERE email = ?';
        const [rows] = await pool.execute(query, [email]);

        if (rows.length === 0) {
            return res.status(200).json({ role: 'guest' }); 
        }

        res.status(200).json({ role: rows[0].role });
    } catch (error) {
        console.error('Fetch Role Error:', error);
        res.status(500).json({ message: 'Failed to fetch user role.' });
    }
});

//get substitute users
app.get('/users/substitutes', verifyToken, async (req, res) => {
    try {
        const { startDate, endDate, applicantEmail } = req.query;

        if (!startDate || !endDate || !applicantEmail) {
            return res.status(400).json({ message: "Missing required parameters" });
        }

        // teachers where their ID is NOT inside the list of people who have an overlapping approved leave.
        const query = `
            SELECT id, name, designation 
            FROM users 
            WHERE role IN ('teacher', 'chairman', 'acting_chairman') 
            AND email != ? 
            
            -- Filter 1: Are they taking a leave themselves during this time?
            AND id NOT IN (
                SELECT applicant_id 
                FROM leave_applications 
                WHERE status IN ('PENDING_SUBSTITUTE', 'PENDING_CHAIRMAN', 'APPROVED') 
                AND start_date <= ? 
                AND end_date >= ?
            )
            
            -- Filter 2: Are they already substituting for someone else during this time?
            AND id NOT IN (
                SELECT substitute_id 
                FROM leave_applications 
                WHERE status IN ('PENDING_CHAIRMAN', 'APPROVED') 
                AND start_date <= ? 
                AND end_date >= ?
            )
        `;
        
        const [availableTeachers] = await pool.execute(query, [
            applicantEmail, 
            endDate, startDate, // Applicant subquery
            endDate, startDate  // Substitute subquery
        ]);
        
        res.status(200).json(availableTeachers);

    } catch (error) {
        console.error('Error fetching substitutes:', error);
        res.status(500).json({ message: 'Failed to fetch substitutes.' });
    }
});

//post users
app.post('/users', verifyToken, async (req, res) => {
    try {
        const { name, email, department, designation } = req.body;

        const query = 'INSERT INTO users (name, email, department, designation) VALUES (?, ?, ?, ?)';
        const values = [name, email, department, designation];

        const [result] = await pool.execute(query, values);
        console.log(result);

        res.status(201).json({
            message: 'User profile saved successfully',
            insertId: result.insertId
        });

    } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') {
            return res.status(400).json({ message: 'This email profile already exists.' });
        }
        console.error('Profile Save Error:', error);
        res.status(500).json({ message: 'Internal server error while saving profile.' });
    }
});

// get a single user's full profile
app.get('/users/:email', verifyToken, async (req, res) => {
    try {
        const email = req.params.email;
        const [rows] = await pool.execute(
            'SELECT name, email, department, designation, role, leave_quota FROM users WHERE email = ?', 
            [email]
        );
        
        if (rows.length === 0) return res.status(404).json({ message: 'User not found' });
        
        res.status(200).json(rows[0]);
    } catch (error) {
        console.error('Fetch User Error:', error);
        res.status(500).json({ message: 'Failed to fetch user profile.' });
    }
});

// PATCH: Update user profile details
app.patch('/users/:email', verifyToken, async (req, res) => {
    try {
        const email = req.params.email;
        
        if (req.decodedUser.email !== email) {
            return res.status(403).json({ message: "Forbidden: You can only edit your own profile." });
        }

        const { name, department, designation } = req.body;

        const query = `
            UPDATE users 
            SET name = ?, department = ?, designation = ? 
            WHERE email = ?
        `;
        
        const [result] = await pool.execute(query, [name, department, designation, email]);

        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'User not found.' });
        }

        res.status(200).json({ message: 'Profile updated successfully.' });

    } catch (error) {
        console.error('Update Profile Error:', error);
        res.status(500).json({ message: 'Internal server error while updating profile.' });
    }
});

//-----------Leave application API---------------

// get users pending approval count to show in banner
app.get('/users/pending-actions/:email', verifyToken, async (req, res) => {
    try {
        const email = req.params.email;
        
        const [userRows] = await pool.execute('SELECT id, role FROM users WHERE email = ?', [email]);
        
        if (userRows.length === 0) {
            return res.status(404).json({ message: 'User not found' });
        }

        const { id, role } = userRows[0];
        let pendingCount = 0;

        if (role === 'chairman' || role === 'acting_chairman') {
            const [rows] = await pool.execute(
                'SELECT COUNT(*) as count FROM leave_applications WHERE status = "PENDING_CHAIRMAN"'
            );
            pendingCount = rows[0].count;
        } else {
            const [rows] = await pool.execute(
                'SELECT COUNT(*) as count FROM leave_applications WHERE substitute_id = ? AND status = "PENDING_SUBSTITUTE"', 
                [id]
            );
            pendingCount = rows[0].count;
        }

        res.status(200).json({ count: pendingCount });

    } catch (error) {
        console.error('Fetch Pending Actions Error:', error);
        res.status(500).json({ message: 'Failed to fetch pending actions.' });
    }
});

// GET all substitute applications for individual teacher (History & Pending)
app.get('/leaveApplications/substitute/:email', verifyToken, async (req, res) => {
    try {
        const substituteEmail = req.params.email;

        const query = `
            SELECT la.*, applicant.name AS applicant_name, applicant.designation AS applicant_designation
            FROM leave_applications la
            JOIN users applicant ON la.applicant_id = applicant.id
            JOIN users substitute ON la.substitute_id = substitute.id
            WHERE substitute.email = ?
            ORDER BY la.created_at DESC
        `;
        
        const [rows] = await pool.execute(query, [substituteEmail]);
        res.status(200).json(rows);

    } catch (error) {
        console.error('Fetch Substitute Requests Error:', error);
        res.status(500).json({ message: 'Failed to fetch requests.' });
    }
});

// get pending-chairman applications for chairman
app.get('/leaveApplications/chairman',verifyToken, verifyChairman, async (req, res) => {
    try {
        const query = `
            SELECT 
                la.*, 
                applicant.name AS applicant_name, 
                applicant.designation AS applicant_designation,
                substitute.name AS substitute_name
            FROM leave_applications la
            JOIN users applicant ON la.applicant_id = applicant.id
            JOIN users substitute ON la.substitute_id = substitute.id
            WHERE la.status = 'PENDING_CHAIRMAN'
            ORDER BY la.created_at ASC
        `;
        
        const [rows] = await pool.execute(query);
        res.status(200).json(rows);

    } catch (error) {
        console.error('Fetch Chairman Requests Error:', error);
        res.status(500).json({ message: 'Failed to fetch applications for Chairman.' });
    }
});

// Get Teacher's own recent activity
app.get('/leaveApplications/me/:email', verifyToken, async (req, res) => {
    try {
        const email = req.params.email;
        
        const limit = req.query.limit ? parseInt(req.query.limit) : null;

        let query = `
            SELECT la.*, sub.name AS substitute_name
            FROM leave_applications la
            JOIN users app ON la.applicant_id = app.id
            LEFT JOIN users sub ON la.substitute_id = sub.id
            WHERE app.email = ?
            ORDER BY la.created_at DESC
        `;

        if (limit && !isNaN(limit)) {
            query += ` LIMIT ${limit}`;
        }

        const [rows] = await pool.execute(query, [email]);
        res.status(200).json(rows);
    } catch (error) {
        console.error('Fetch My Activity Error:', error);
        res.status(500).json({ message: 'Failed to fetch activity.' });
    }
});

// Get Chairman's global recent activity
app.get('/leaveApplications/department',verifyToken, verifyChairman, async (req, res) => {
    try {
        const limit = req.query.limit ? parseInt(req.query.limit) : null;

        let query = `
            SELECT la.*, app.name AS applicant_name, sub.name AS substitute_name
            FROM leave_applications la
            JOIN users app ON la.applicant_id = app.id
            LEFT JOIN users sub ON la.substitute_id = sub.id
            ORDER BY la.created_at DESC
        `;

        if (limit && !isNaN(limit)) {
            query += ` LIMIT ${limit}`;
        }

        const [rows] = await pool.execute(query);
        res.status(200).json(rows);
    } catch (error) {
        console.error('Fetch Dept Activity Error:', error);
        res.status(500).json({ message: 'Failed to fetch department activity.' });
    }
});

// GET a single application for edit or view
app.get('/leaveApplications/details/:id', verifyToken, async (req, res) => {
    try {
        const applicationId = req.params.id;
        const { email, role } = req.query; // Grab the identifiers sent from the frontend

        // 1. First layer of security: Ensure they sent their credentials
        if (!email || !role) {
            return res.status(400).json({ message: 'Missing user authorization parameters.' });
        }

        // 2. Base Query
        let query = `
            SELECT 
                la.*, 
                app.name AS applicant_name,
                app.email AS applicant_email,
                sub.name AS substitute_name,
                sub.email AS substitute_email
            FROM leave_applications la
            JOIN users app ON la.applicant_id = app.id
            LEFT JOIN users sub ON la.substitute_id = sub.id
            WHERE la.id = ?
        `;
        
        let queryParams = [applicationId];

        // 3. Dynamic Authorization Rule
        // If they are not a Chairman, they can ONLY view rows where they are involved.
        if (role !== 'chairman' && role !== 'acting_chairman') {
            query += ` AND (app.email = ? OR sub.email = ?)`;
            queryParams.push(email, email);
        }

        const [rows] = await pool.execute(query, queryParams);
        
        // 4. If nothing returns, they either typed a bad ID, or they tried to snoop on someone else!
        // We return 404 for both so attackers can't guess valid IDs.
        if (rows.length === 0) {
            return res.status(404).json({ message: 'Request not found or access denied.' });
        }
        
        res.status(200).json(rows[0]);

    } catch (error) {
        console.error('Fetch Details Error:', error);
        res.status(500).json({ message: 'Failed to fetch application details.' });
    }
});

// POST leaveApplications - Submit a new leave application
app.post('/leaveApplications', verifyToken, async (req, res) => {
    const connection = await pool.getConnection(); 
    
    try {
        await connection.beginTransaction();

        const { startDate, endDate, totalDaysDeducted, substituteId, reason, applicantEmail } = req.body;

        const [userRows] = await connection.execute(
            'SELECT id, name, leave_quota FROM users WHERE email = ?', 
            [applicantEmail]
        );
        
        if (userRows.length === 0) throw new Error('Applicant not found in database');
        const applicant = userRows[0];

        if (applicant.leave_quota < totalDaysDeducted) {
            await connection.rollback();
            return res.status(400).json({ message: `Insufficient quota.` });
        }

        const [subRows] = await connection.execute('SELECT email FROM users WHERE id = ?', [substituteId]);
        const substituteEmail = subRows.length > 0 ? subRows[0].email : null;

        const insertQuery = `
            INSERT INTO leave_applications 
            (applicant_id, substitute_id, start_date, end_date, total_days, reason, status) 
            VALUES (?, ?, ?, ?, ?, ?, 'PENDING_SUBSTITUTE')
        `;
        const [result] = await connection.execute(insertQuery, [
            applicant.id, substituteId, startDate, endDate, totalDaysDeducted, reason
        ]);

        await connection.commit(); 
        
        // --- TRIGGER NOTIFICATION ---
        if (substituteEmail) {
            await createNotification(
                substituteEmail, 
                'NEW_SUBSTITUTE_REQUEST', 
                'warning', 
                `${applicant.name} has requested you as a substitute.`, 
                '/substituteRequests'
            );
        }

        res.status(201).json({ message: 'Leave application submitted successfully', insertId: result.insertId });

    } catch (error) {
        await connection.rollback();
        console.error('Leave Submission Error:', error);
        res.status(500).json({ message: 'Internal server error during submission.' });
    } finally {
        connection.release();
    }
});

// Update an existing application (Only if PENDING_SUBSTITUTE)
app.put('/leaveApplications/:id', verifyToken, async (req, res) => {
    try {
        const applicationId = req.params.id;
        const { startDate, endDate, totalDaysDeducted, substituteId, reason } = req.body;

        const [appRows] = await pool.execute(`
            SELECT la.status, la.substitute_id, u.name as applicant_name 
            FROM leave_applications la
            JOIN users u ON la.applicant_id = u.id
            WHERE la.id = ?
        `, [applicationId]);

        if (appRows.length === 0) {
            return res.status(404).json({ message: 'Application not found.' });
        }

        if (appRows[0].status !== 'PENDING_SUBSTITUTE') {
            return res.status(403).json({ 
                message: 'Update failed. This application has already been processed by the substitute.' 
            });
        }

        const oldSubstituteId = appRows[0].substitute_id;
        const applicantName = appRows[0].applicant_name;

        const updateQuery = `
            UPDATE leave_applications 
            SET start_date = ?, end_date = ?, total_days = ?, substitute_id = ?, reason = ?
            WHERE id = ?
        `;
        
        await pool.execute(updateQuery, [
            startDate, endDate, totalDaysDeducted, substituteId, reason, applicationId
        ]);

        // --- TRIGGER NOTIFICATIONS ---
        const [newSubRows] = await pool.execute('SELECT email FROM users WHERE id = ?', [substituteId]);
        const newSubEmail = newSubRows.length > 0 ? newSubRows[0].email : null;

        if (newSubEmail) {
            if (oldSubstituteId !== substituteId) {
                // Scenario A: They picked a completely new substitute
                await createNotification(
                    newSubEmail, 
                    'NEW_SUBSTITUTE_REQUEST', 
                    'warning', 
                    `${applicantName} has requested you as a substitute.`, 
                    '/substituteRequests'
                );
            } else {
                // Scenario B: They just changed the dates or reason
                await createNotification(
                    newSubEmail, 
                    'REQUEST_UPDATED', 
                    'info', 
                    `${applicantName} has updated the details of their leave request.`, 
                    '/substituteRequests'
                );
            }
        }

        res.status(200).json({ message: 'Leave application updated successfully.' });

    } catch (error) {
        console.error('Update Application Error:', error);
        res.status(500).json({ message: 'Internal server error during update.' });
    }
});

// accept or reject application by a substitute
app.patch('/leaveApplications/:id/substitute-action', verifyToken, async (req, res) => {
    try {
        const applicationId = req.params.id;
        const { action } = req.body;

        const [appRows] = await pool.execute(`
            SELECT la.start_date, u.email as applicant_email 
            FROM leave_applications la
            JOIN users u ON la.applicant_id = u.id
            WHERE la.id = ?
        `, [applicationId]);
        
        if (appRows.length === 0) return res.status(404).json({ message: 'Application not found.' });

        const application = appRows[0];
        const currentTime = new Date(); 
        const todayAtMidnight = new Date(currentTime);
        todayAtMidnight.setHours(0,0,0,0);
        const startDate = new Date(application.start_date);
        startDate.setHours(0,0,0,0); 

        if (action === 'accept') {
            let isExpired = false;
            if (todayAtMidnight > startDate) isExpired = true;
            else if (todayAtMidnight.getTime() === startDate.getTime() && currentTime.getHours() >= 10) isExpired = true;

            if (isExpired) return res.status(400).json({ message: 'The deadline for this leave has passed.' });
        }

        let newStatus = '';
        if (action === 'accept') newStatus = 'PENDING_CHAIRMAN';
        else if (action === 'reject') newStatus = 'REJECTED_BY_SUBSTITUTE';
        else return res.status(400).json({ message: 'Invalid action.' });

        await pool.execute('UPDATE leave_applications SET status = ? WHERE id = ?', [newStatus, applicationId]);

        // --- TRIGGER NOTIFICATION ---
        if (action === 'accept') {
            await createNotification(application.applicant_email, 'SUBSTITUTE_ACCEPTED', 'success', 'Your substitute accepted your request. Pending Chairman approval.', '/myRequests');
        } else if (action === 'reject') {
            await createNotification(application.applicant_email, 'SUBSTITUTE_REJECTED', 'error', 'Your substitute rejected your leave request.', '/myRequests');
        }

        res.status(200).json({ message: `Application ${action}ed successfully.`, status: newStatus });

    } catch (error) {
        console.error('Update Application Error:', error);
        res.status(500).json({ message: 'Failed to update application status.' });
    }
});

// PATCH : accept or reject application by chairman
app.patch('/leaveApplications/:id/chairman-action',verifyToken, verifyChairman, async (req, res) => {
    const connection = await pool.getConnection();

    try {
        const applicationId = req.params.id;
        const { action } = req.body;

        await connection.beginTransaction();

        const [appRows] = await connection.execute(`
            SELECT 
                la.applicant_id, la.total_days, la.status, 
                app.email as applicant_email, 
                sub.email as substitute_email
            FROM leave_applications la 
            JOIN users app ON la.applicant_id = app.id
            JOIN users sub ON la.substitute_id = sub.id
            WHERE la.id = ? FOR UPDATE
        `, [applicationId]);

        if (appRows.length === 0) {
            await connection.rollback();
            return res.status(404).json({ message: 'Application not found.' });
        }

        const application = appRows[0];

        if (application.status !== 'PENDING_CHAIRMAN') {
            await connection.rollback();
            return res.status(400).json({ message: 'Application is not pending chairman approval.' });
        }

        if (action === 'reject') {
            await connection.execute('UPDATE leave_applications SET status = "REJECTED_BY_CHAIRMAN" WHERE id = ?', [applicationId]);
            await connection.commit(); 
            
            // --- TRIGGER NOTIFICATIONS ---
            // 1. Notify Applicant
            await createNotification(application.applicant_email, 'LEAVE_REJECTED', 'error', 'Your leave application was rejected by the Chairman.', '/myRequests');
            // 2. Notify Substitute
            await createNotification(application.substitute_email, 'LEAVE_REJECTED', 'error', 'A leave request you accepted to substitute for was rejected by the Chairman.', '/substituteRequests');
            
            return res.status(200).json({ message: 'Leave application rejected.', status: 'REJECTED_BY_CHAIRMAN' });
        } 
        
        if (action === 'accept') {
            await connection.execute('UPDATE leave_applications SET status = "APPROVED" WHERE id = ?', [applicationId]);
            await connection.execute('UPDATE users SET leave_quota = leave_quota - ? WHERE id = ?', [application.total_days, application.applicant_id]);
            await connection.commit(); 
            
            // --- TRIGGER NOTIFICATIONS ---
            // 1. Notify Applicant
            await createNotification(application.applicant_email, 'LEAVE_APPROVED', 'success', 'Your leave application has been approved!', '/myRequests');
            // 2. Notify Substitute
            await createNotification(application.substitute_email, 'LEAVE_APPROVED', 'success', 'The Chairman approved the leave request you are substituting for.', '/substituteRequests');
            
            return res.status(200).json({ message: 'Leave application approved.', status: 'APPROVED' });
        }

        await connection.rollback();
        return res.status(400).json({ message: 'Invalid action.' });

    } catch (error) {
        await connection.rollback(); 
        console.error('Chairman Action Error:', error);
        res.status(500).json({ message: 'Internal server error while processing chairman action.' });
    } finally {
        connection.release(); 
    }
});

// GET personal blocked dates for calendar (Own leaves + Accepted substitute duties)
app.get('/leaveApplications/blockedDates/:email', verifyToken, async (req, res) => {
    try {
        const email = req.params.email;

        const [userRows] = await pool.execute('SELECT id FROM users WHERE email = ?', [email]);
        if (userRows.length === 0) return res.status(404).json({ message: 'User not found' });
        
        const userId = userRows[0].id;

        const query = `
            SELECT 
                id as application_id, 
                start_date, 
                end_date,
                CASE 
                    WHEN applicant_id = ? THEN 'APPLIED'
                    WHEN substitute_id = ? THEN 'SUBSTITUTE'
                END AS block_type
            FROM leave_applications 
            WHERE 
                (applicant_id = ? AND status IN ('PENDING_SUBSTITUTE', 'PENDING_CHAIRMAN', 'APPROVED'))
                OR 
                (substitute_id = ? AND status IN ('PENDING_CHAIRMAN', 'APPROVED'))
        `;
        
        const [blockedDates] = await pool.execute(query, [userId, userId, userId, userId]);
        
        res.status(200).json(blockedDates);

    } catch (error) {
        console.error('Fetch Blocked Dates Error:', error);
        res.status(500).json({ message: 'Failed to fetch blocked dates.' });
    }
});

//-----------DASHBOARD STATS API---------------

// GET Chairman Dashboard Statistics & Active Leaves
app.get('/stats/chairman', verifyToken, verifyChairman, async (req, res) => {
    try {
        // 1. Pending Chairman Approvals
        const [pendingRows] = await pool.execute(
            'SELECT COUNT(*) as count FROM leave_applications WHERE status = "PENDING_CHAIRMAN"'
        );
        
        // 2. Teachers Absent Today
        const [absentRows] = await pool.execute(`
            SELECT COUNT(*) as count 
            FROM leave_applications 
            WHERE status = 'APPROVED' 
            AND start_date <= CURDATE() 
            AND end_date >= CURDATE()
        `);
        
        // 3. Department Leave Trends (Approved leaves this month)
        const [monthlyTrendRows] = await pool.execute(`
            SELECT COUNT(*) as count 
            FROM leave_applications 
            WHERE status = 'APPROVED'
            AND MONTH(start_date) = MONTH(CURDATE())
            AND YEAR(start_date) = YEAR(CURDATE())
        `);

        // 4. Who is on leave today (Detailed list for the widget)
        const [onLeaveToday] = await pool.execute(`
            SELECT 
                la.id, 
                la.start_date, 
                la.end_date, 
                la.total_days, 
                u.name, 
                u.designation,
                u.department
            FROM leave_applications la
            JOIN users u ON la.applicant_id = u.id
            WHERE la.status = 'APPROVED' 
            AND la.start_date <= CURDATE() 
            AND la.end_date >= CURDATE()
            ORDER BY la.end_date ASC
        `);

        res.status(200).json({
            pendingApprovals: pendingRows[0].count,
            absentToday: absentRows[0].count,
            approvedThisMonth: monthlyTrendRows[0].count,
            activeLeaves: onLeaveToday
        });

    } catch (error) {
        console.error('Fetch Chairman Stats Error:', error);
        res.status(500).json({ message: 'Failed to fetch department statistics.' });
    }
});

//-----------HOLIDAY RELATED API---------------

//get holidays
app.get('/holidays', verifyToken, async (req, res) => {
    try {
        const { upcoming } = req.query;

        let query = 'SELECT * FROM holidays ORDER BY start_date ASC';

        if (upcoming === 'true') {
            query = 'SELECT * FROM holidays WHERE end_date >= CURDATE() ORDER BY start_date ASC';
        }

        const [holidays] = await pool.execute(query);
        
        res.status(200).json(holidays);
    } catch (error) {
        console.error('Fetch Holidays Error:', error);
        res.status(500).json({ message: 'Failed to fetch holidays.' });
    }
});
//-----------AUTHORITY DELEGATION API---------------

// POST: Delegate Authority to a Teacher
app.post('/delegateAuthority',verifyToken, verifyChairman, async (req, res) => {
    const connection = await pool.getConnection(); 
    
    try {
        await connection.beginTransaction(); 

        const { delegatedTo, startDate, endDate, reason, chairmanEmail } = req.body;

        const [chairmanRows] = await connection.execute('SELECT id, role FROM users WHERE email = ?', [chairmanEmail]);
        if (chairmanRows.length === 0 || chairmanRows[0].role !== 'chairman') {
            await connection.rollback();
            return res.status(403).json({ message: 'Unauthorized.' });
        }
        
        const delegatedBy = chairmanRows[0].id;

        // NEW: Fetch the target teacher's email for notification
        const [targetRows] = await connection.execute('SELECT email FROM users WHERE id = ?', [delegatedTo]);
        const targetEmail = targetRows.length > 0 ? targetRows[0].email : null;

        const insertQuery = `
            INSERT INTO authority_delegations 
            (delegated_to, delegated_by, start_date, end_date, reason, status) 
            VALUES (?, ?, ?, ?, ?, 'ACTIVE')
        `;
        await connection.execute(insertQuery, [delegatedTo, delegatedBy, startDate, endDate, reason]);
        await connection.execute('UPDATE users SET role = "acting_chairman" WHERE id = ?', [delegatedTo]);

        await connection.commit(); 
        
        // --- TRIGGER NOTIFICATION ---
        if (targetEmail) {
            await createNotification(targetEmail, 'AUTHORITY_DELEGATED', 'info', 'You have been granted Acting Chairman authority.', '/');
        }

        res.status(201).json({ message: 'Authority delegated successfully.' });

    } catch (error) {
        await connection.rollback();
        console.error('Delegate Authority Error:', error);
        res.status(500).json({ message: 'Internal server error during delegation.' });
    } finally {
        connection.release();
    }
});

// GET: Check for an active delegation
app.get('/active-delegation',verifyToken, verifyChairman, async (req, res) => {
    try {
        const query = `
            SELECT ad.*, u.name as delegated_to_name 
            FROM authority_delegations ad
            JOIN users u ON ad.delegated_to = u.id
            WHERE ad.status = 'ACTIVE' 
            AND ad.start_date <= CURDATE() 
            AND ad.end_date >= CURDATE()
            LIMIT 1
        `;
        const [rows] = await pool.execute(query);
        
        res.json(rows.length > 0 ? rows[0] : null);
    } catch (error) {
        console.error("Error fetching active delegation:", error);
        res.status(500).json({ message: "Server error" });
    }
});

// POST: Revoke an active delegation early
app.post('/revoke-delegation/:id',verifyToken, verifyChairman, async (req, res) => {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        const delegationId = req.params.id;

        // UPDATED: Join to get the user's email
        const [delegation] = await connection.execute(`
            SELECT ad.delegated_to, u.email 
            FROM authority_delegations ad
            JOIN users u ON ad.delegated_to = u.id
            WHERE ad.id = ?
        `, [delegationId]);

        if (delegation.length > 0) {
            const userId = delegation[0].delegated_to;
            const userEmail = delegation[0].email;
            
            await connection.execute('UPDATE users SET role = "teacher" WHERE id = ?', [userId]);
            await connection.execute('UPDATE authority_delegations SET status = "REVOKED" WHERE id = ?', [delegationId]);
            
            await connection.commit();

            // --- TRIGGER NOTIFICATION ---
            await createNotification(userEmail, 'AUTHORITY_REVOKED', 'info', 'Your Acting Chairman authority has been revoked.', '/');
        } else {
            await connection.commit();
        }

        res.json({ message: "Authority revoked successfully." });
    } catch (error) {
        await connection.rollback();
        console.error("Error revoking delegation:", error);
        res.status(500).json({ message: "Server error during revocation" });
    } finally {
        connection.release();
    }
});

// --- NOTIFICATIONS API ---

app.get('/notifications/:email', verifyToken, async (req, res) => {
    try {
        const { email } = req.params;
        
        const [notifications] = await pool.execute(`
            SELECT n.* 
            FROM notifications n
            JOIN users u ON n.user_id = u.id
            WHERE u.email = ?
            ORDER BY n.created_at DESC
            LIMIT 50
        `, [email]);
        
        res.status(200).json(notifications);
    } catch (error) {
        console.error('Fetch Notifications Error:', error);
        res.status(500).json({ message: 'Failed to fetch notifications.' });
    }
});

//mark a single notification as read
app.patch('/notifications/:id/read', verifyToken, async (req, res) => {
    try {
        const { id } = req.params;
        
        await pool.execute(`
            UPDATE notifications 
            SET is_read = TRUE 
            WHERE id = ?
        `, [id]);
        
        res.status(200).json({ message: 'Notification marked as read.' });
    } catch (error) {
        console.error('Update Notification Error:', error);
        res.status(500).json({ message: 'Failed to mark notification as read.' });
    }
});

//mark all notifications as read
app.patch('/notifications/read-all/:email', verifyToken, async (req, res) => {
    try {
        const { email } = req.params;
        
        await pool.execute(`
            UPDATE notifications n
            JOIN users u ON n.user_id = u.id
            SET n.is_read = TRUE 
            WHERE u.email = ? AND n.is_read = FALSE
        `, [email]);
        
        res.status(200).json({ message: 'All notifications marked as read.' });
    } catch (error) {
        console.error('Mark All Read Error:', error);
        res.status(500).json({ message: 'Failed to mark all notifications as read.' });
    }
});


//----------------CRON JOB API----------------------
cron.schedule('1 10 * * *', async () => {
    console.log('Running background maintenance tasks...');
    
    try {
        // TASK 1: Auto-expire abandoned leave requests
        const [expiringLeaves] = await pool.execute(`
            SELECT 
                la.id, la.status, 
                app.email as applicant_email,
                sub.email as substitute_email
            FROM leave_applications la
            JOIN users app ON la.applicant_id = app.id
            JOIN users sub ON la.substitute_id = sub.id
            WHERE la.status IN ('PENDING_SUBSTITUTE', 'PENDING_CHAIRMAN') 
            AND (
                DATE(la.start_date) < CURDATE() 
                OR (DATE(la.start_date) = CURDATE() AND HOUR(NOW()) >= 10)
            )
        `);

        if (expiringLeaves.length > 0) {
            const leaveQuery = `
                UPDATE leave_applications 
                SET status = CASE
                    WHEN status = 'PENDING_SUBSTITUTE' THEN 'EXPIRED_SUBSTITUTE'
                    WHEN status = 'PENDING_CHAIRMAN' THEN 'EXPIRED_CHAIRMAN'
                END
                WHERE status IN ('PENDING_SUBSTITUTE', 'PENDING_CHAIRMAN') 
                AND (
                    DATE(start_date) < CURDATE() 
                    OR (DATE(start_date) = CURDATE() AND HOUR(NOW()) >= 10)
                )
            `;
            const [leaveResult] = await pool.execute(leaveQuery);
            console.log(`Successfully auto-expired ${leaveResult.affectedRows} abandoned request(s).`);

            // Send expiration notifications to EVERYONE involved!
            for (const leave of expiringLeaves) {
                
                // 1. Always notify the applicant their leave died
                await createNotification(
                    leave.applicant_email,
                    'LEAVE_EXPIRED',
                    'error',
                    'Your leave request expired because it was not approved in time.',
                    '/myRequests'
                );

                // 2. Notify the substitute 
                if (leave.status === 'PENDING_SUBSTITUTE') {
                    // It expired before the substitute even answered
                    await createNotification(
                        leave.substitute_email,
                        'LEAVE_EXPIRED',
                        'warning',
                        'A substitute request sent to you has expired.',
                        '/substituteRequests'
                    );
                } else if (leave.status === 'PENDING_CHAIRMAN') {
                    // The substitute accepted it, but the Chairman never answered in time!
                    await createNotification(
                        leave.substitute_email,
                        'LEAVE_EXPIRED',
                        'error',
                        'A leave request you accepted to cover has expired (Chairman did not approve in time).',
                        '/substituteRequests'
                    );
                }
            }
        }

        // TASK 2: Auto-revoke expired acting_chairman roles
        const findDelegationsQuery = `
            SELECT ad.delegated_to, u.email 
            FROM authority_delegations ad
            JOIN users u ON ad.delegated_to = u.id
            WHERE ad.status = 'ACTIVE' AND ad.end_date < CURDATE()
        `;
        const [expiredDelegations] = await pool.execute(findDelegationsQuery);

        if (expiredDelegations.length > 0) {
            const userIds = expiredDelegations.map(d => d.delegated_to);

            await pool.execute(
                `UPDATE authority_delegations SET status = 'COMPLETED' WHERE status = 'ACTIVE' AND end_date < CURDATE()`
            );

            for (const delegation of expiredDelegations) {
                await pool.execute(`UPDATE users SET role = 'teacher' WHERE id = ?`, [delegation.delegated_to]);
                
                // Send revocation notifications!
                await createNotification(
                    delegation.email,
                    'AUTHORITY_EXPIRED',
                    'info',
                    'Your Acting Chairman authority has automatically expired.',
                    '/'
                );
            }
            console.log(`Successfully revoked acting_chairman authority for ${userIds.length} user(s).`);
        }

    } catch (error) {
        console.error('Error during background cron job:', error);
    }
}, {
    scheduled: true,
    timezone: "Asia/Dhaka" 
});

app.get('/', (req, res)=>{
    res.send("Leave application system running!")
})

app.listen(port, ()=>{
    console.log(`Server is listening on port ${port}`);
})
