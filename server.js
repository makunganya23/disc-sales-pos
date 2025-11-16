// Improved server.js with recommended enhancements

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const PORT = process.env.PORT || 3000;

// Middleware
app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100
});
app.use(limiter);

// Database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl:
    process.env.NODE_ENV === "production"
      ? { rejectUnauthorized: false }
      : false
});

// Track active WebSocket connections
const activeUsers = new Map();

// Auto-update timestamps using PostgreSQL trigger
async function createUpdateTimestampTrigger() {
  await pool.query(`
    CREATE OR REPLACE FUNCTION update_timestamp()
    RETURNS TRIGGER AS $$
    BEGIN
      NEW.updated_at = NOW();
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);

  await pool.query(`
    CREATE TRIGGER update_products_timestamp
    BEFORE UPDATE ON products
    FOR EACH ROW
    EXECUTE FUNCTION update_timestamp();
  `);
}

// WebSocket handling
io.on('connection', (socket) => {
  socket.on('authenticate', (userData) => {
    activeUsers.set(socket.id, userData);
    socket.broadcast.emit('user_online', {
      userId: userData.id,
      userName: userData.full_name,
      timestamp: new Date().toISOString()
    });
  });

  socket.on('product_updated', (data) => {
    socket.broadcast.emit('product_updated', {
      ...data,
      updatedBy: activeUsers.get(socket.id)?.full_name,
      timestamp: new Date().toISOString()
    });
  });

  socket.on('sale_created', (data) => {
    socket.broadcast.emit('sale_created', {
      ...data,
      createdBy: activeUsers.get(socket.id)?.full_name,
      timestamp: new Date().toISOString()
    });
  });

  socket.on('disconnect', () => {
    const userData = activeUsers.get(socket.id);
    if (userData) {
      activeUsers.delete(socket.id);
      socket.broadcast.emit('user_offline', {
        userId: userData.id,
        userName: userData.full_name,
        timestamp: new Date().toISOString()
      });
    }
  });
});

// Test DB connection
pool.connect((err, client, release) => {
  if (!err) release();
});

// Initialize DB tables + triggers
async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      full_name VARCHAR(100) NOT NULL,
      email VARCHAR(100) UNIQUE NOT NULL,
      password VARCHAR(255) NOT NULL,
      role VARCHAR(20) DEFAULT 'cashier',
      status VARCHAR(20) DEFAULT 'pending',
      bio TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      last_login TIMESTAMP,
      CONSTRAINT valid_role CHECK (role IN ('superadmin', 'admin', 'manager', 'cashier')),
      CONSTRAINT valid_status CHECK (status IN ('active', 'pending', 'blocked'))
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS products (
      id SERIAL PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      category VARCHAR(50) NOT NULL,
      purchase_price DECIMAL(10,2) NOT NULL,
      selling_price DECIMAL(10,2) NOT NULL,
      stock INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS sales (
      id SERIAL PRIMARY KEY,
      date DATE NOT NULL,
      customer VARCHAR(100) NOT NULL,
      total DECIMAL(10,2) NOT NULL,
      user_id INTEGER REFERENCES users(id),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS sale_items (
      id SERIAL PRIMARY KEY,
      sale_id INTEGER REFERENCES sales(id) ON DELETE CASCADE,
      product_id INTEGER REFERENCES products(id),
      quantity INTEGER NOT NULL,
      unit_price DECIMAL(10,2) NOT NULL,
      total_price DECIMAL(10,2) NOT NULL
    );
  `);

  await createUpdateTimestampTrigger();
}

// Auth middleware
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) return res.status(401).json({ error: 'Access token required' });

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid or expired token' });
    req.user = user;
    next();
  });
};

// Start server
initializeDatabase().then(() => {
  server.listen(PORT, () => {});
});

module.exports = app;
