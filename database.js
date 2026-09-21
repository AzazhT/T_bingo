const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

const initDb = async () => {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                identifier VARCHAR(255) PRIMARY KEY,
                name VARCHAR(255),
                username VARCHAR(255),
                balance NUMERIC(10, 2) DEFAULT 0.00,
                phone VARCHAR(50) DEFAULT 'አልተጋራም'
            );
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS transactions (
                tx_id VARCHAR(50) PRIMARY KEY,
                identifier VARCHAR(255),
                type VARCHAR(50),
                amount NUMERIC(10, 2),
                handled BOOLEAN DEFAULT FALSE
            );
        `);

        await pool.query(`
            ALTER TABLE transactions ADD COLUMN IF NOT EXISTS id SERIAL;
        `);

        console.log("Database & Tables connected/created successfully!");
    } catch (err) {
        console.error("Database connection error:", err);
    }
};

initDb();

module.exports = pool;