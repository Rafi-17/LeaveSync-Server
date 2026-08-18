const mysql = require('mysql2/promise');
require('dotenv').config();

const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE,
    waitForConnections: true,
    connectionLimit: 4,
    queueLimit: 0
})

// Test the connection instantly when the server starts
pool.getConnection()
.then(connection=>{
    console.log('✅ Successfully connected to MySQL database!');
    connection.release();
})
.catch(err=>{
    console.error('❌ Error connecting to MySQL:', err);
})

module.exports = pool;