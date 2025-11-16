// server.js - Disc Sales POS System - Fixed Version
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

// 🔧 FIX: ADD TRUST PROXY FOR VERCEL
app.set('trust proxy', 1);

// Middleware
app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// 🔧 FIX: RATE LIMITING WITH PROXY SETTINGS
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);

// Database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Track active WebSocket connections
const activeUsers = new Map();

// DATABASE INITIALIZATION FUNCTION
async function initializeDatabase() {
  try {
    console.log('🔄 Checking database tables...');
    
    // Check if users table exists
    const tableCheck = await pool.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'users'
    `);
    
    if (tableCheck.rows.length === 0) {
      console.log('❌ Users table missing. Creating tables...');
      
      // Create users table
      await pool.query(`
        CREATE TABLE users (
          id SERIAL PRIMARY KEY,
          full_name VARCHAR(100) NOT NULL,
          email VARCHAR(100) UNIQUE NOT NULL,
          password VARCHAR(255) NOT NULL,
          role VARCHAR(20) DEFAULT 'cashier',
          status VARCHAR(20) DEFAULT 'pending',
          bio TEXT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          last_login TIMESTAMP
        );
      `);
      console.log('✅ Users table created');

      // Create products table
      await pool.query(`
        CREATE TABLE products (
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
      console.log('✅ Products table created');

      // Create sales table
      await pool.query(`
        CREATE TABLE sales (
          id SERIAL PRIMARY KEY,
          date DATE NOT NULL,
          customer VARCHAR(100) NOT NULL,
          total DECIMAL(10,2) NOT NULL,
          user_id INTEGER REFERENCES users(id),
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
      `);
      console.log('✅ Sales table created');

      // Create sale_items table
      await pool.query(`
        CREATE TABLE sale_items (
          id SERIAL PRIMARY KEY,
          sale_id INTEGER REFERENCES sales(id) ON DELETE CASCADE,
          product_id INTEGER REFERENCES products(id),
          quantity INTEGER NOT NULL,
          unit_price DECIMAL(10,2) NOT NULL,
          total_price DECIMAL(10,2) NOT NULL
        );
      `);
      console.log('✅ Sale items table created');

      // Create default super admin user
      const hashedPassword = await bcrypt.hash('admin123', 10);
      await pool.query(
        `INSERT INTO users (full_name, email, password, role, status) 
         VALUES ($1, $2, $3, $4, $5)`,
        ['Super Admin', 'admin@disc.com', hashedPassword, 'superadmin', 'active']
      );
      console.log('✅ Default admin user created');

    } else {
      console.log('✅ Database tables already exist');
      
      // 🔧 FIX: Ensure status column exists
      try {
        await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT \'pending\'');
        console.log('✅ Status column verified');
        
        // Update existing users to active if status is null
        await pool.query('UPDATE users SET status = \'active\' WHERE status IS NULL');
        console.log('✅ Existing users status updated');
      } catch (alterError) {
        console.log('ℹ️ Status column already exists');
      }
      
      // Log existing tables
      const tables = await pool.query(`
        SELECT table_name 
        FROM information_schema.tables 
        WHERE table_schema = 'public'
      `);
      console.log('📊 Existing tables:', tables.rows.map(t => t.table_name));
    }
    
    console.log('🎉 Database initialization completed successfully!');
    
  } catch (error) {
    console.log('❌ Database initialization failed:', error.message);
  }
}

// WebSocket handling
io.on('connection', (socket) => {
  console.log('🔌 New client connected:', socket.id);

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
    console.log('🔌 Client disconnected:', socket.id);
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

// AUTHENTICATION ENDPOINTS

// 🔧 FIX 1: User Registration - FIXED VERSION
app.post('/api/register', async (req, res) => {
  try {
    const { full_name, email, password } = req.body;
    
    console.log('📝 Registration attempt:', { full_name, email });
    
    // Validate input
    if (!full_name || !email || !password) {
      return res.status(400).json({ error: 'All fields are required' });
    }

    // Check if user exists
    const userExists = await pool.query(
      'SELECT * FROM users WHERE email = $1',
      [email]
    );
    
    if (userExists.rows.length > 0) {
      return res.status(400).json({ error: 'User already exists' });
    }
    
    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);
    
    // Check if first user (should be superadmin)
    const userCount = await pool.query('SELECT COUNT(*) FROM users');
    const isFirstUser = parseInt(userCount.rows[0].count) === 0;
    
    // 🔧 FIX: First user = superadmin, others = pending
    const role = isFirstUser ? 'superadmin' : 'cashier';
    const status = isFirstUser ? 'active' : 'pending'; // 🔧 NEW USERS ARE PENDING
    
    // Create user
    const newUser = await pool.query(
      `INSERT INTO users (full_name, email, password, role, status) 
       VALUES ($1, $2, $3, $4, $5) RETURNING id, full_name, email, role, status, created_at`,
      [full_name, email, hashedPassword, role, status]
    );
    
    console.log('✅ User registered successfully:', newUser.rows[0].email, 'Status:', status);
    
    res.json({ 
      success: true,
      message: isFirstUser ? 'Super Admin created successfully!' : 'Registration successful! Please wait for admin approval.',
      user: newUser.rows[0],
      requiresApproval: !isFirstUser // 🔧 TELL FRONTEND IF APPROVAL IS NEEDED
    });
    
  } catch (error) {
    console.log('❌ Registration error:', error.message);
    res.status(500).json({ 
      success: false,
      error: 'Registration failed: ' + error.message 
    });
  }
});

// 🔧 FIX 2: User Login - FIXED VERSION
app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    console.log('🔐 Login attempt:', email);
    
    // Find user
    const userResult = await pool.query(
      'SELECT * FROM users WHERE email = $1',
      [email]
    );
    
    if (userResult.rows.length === 0) {
      return res.status(400).json({ 
        success: false,
        error: 'Invalid email or password' 
      });
    }
    
    const user = userResult.rows[0];
    
    // Check password
    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      return res.status(400).json({ 
        success: false,
        error: 'Invalid email or password' 
      });
    }
    
    // 🔧 FIX: Check if user is active
    if (user.status !== 'active') {
      return res.status(400).json({ 
        success: false,
        error: 'Account is pending approval. Please contact administrator.' 
      });
    }
    
    // Update last login
    await pool.query(
      'UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = $1',
      [user.id]
    );
    
    // Generate token
    const token = jwt.sign(
      { 
        id: user.id, 
        email: user.email, 
        role: user.role,
        name: user.full_name 
      },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );
    
    console.log('✅ Login successful:', user.email);
    
    res.json({
      success: true,
      message: 'Login successful',
      token,
      user: {
        id: user.id,
        full_name: user.full_name,
        email: user.email,
        role: user.role,
        status: user.status
      }
    });
    
  } catch (error) {
    console.log('❌ Login error:', error.message);
    res.status(500).json({ 
      success: false,
      error: 'Login failed: ' + error.message 
    });
  }
});

// Authentication middleware
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid or expired token' });
    }
    req.user = user;
    next();
  });
};

// 🔧 FIX 3: USER MANAGEMENT ENDPOINTS

// Get all users
app.get('/api/users', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, full_name, email, role, status, created_at, last_login 
      FROM users 
      ORDER BY created_at DESC
    `);
    res.json({ success: true, users: result.rows });
  } catch (error) {
    console.log('❌ Get users error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 🔧 NEW: GET PENDING USERS (For Admin)
app.get('/api/users/pending', authenticateToken, async (req, res) => {
  try {
    // Check if user is admin
    if (!['superadmin', 'admin'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Access denied. Admin only.' });
    }

    const result = await pool.query(
      'SELECT id, full_name, email, role, status, created_at FROM users WHERE status = $1 ORDER BY created_at DESC',
      ['pending']
    );
    
    res.json({ success: true, users: result.rows });
  } catch (error) {
    console.log('❌ Get pending users error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 🔧 NEW: APPROVE USER (For Admin)
app.put('/api/users/:id/approve', authenticateToken, async (req, res) => {
  try {
    // Check if user is admin
    if (!['superadmin', 'admin'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Access denied. Admin only.' });
    }

    const { id } = req.params;
    
    const result = await pool.query(
      'UPDATE users SET status = $1 WHERE id = $2 RETURNING id, full_name, email, role, status',
      ['active', id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }
    
    console.log('✅ User approved:', result.rows[0].email);
    
    res.json({ 
      success: true, 
      message: 'User approved successfully',
      user: result.rows[0] 
    });
    
  } catch (error) {
    console.log('❌ Approve user error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// PRODUCT ENDPOINTS

// Get all products
app.get('/api/products', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM products ORDER BY name');
    res.json({ success: true, products: result.rows });
  } catch (error) {
    console.log('❌ Get products error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 🔧 FIX 4: ADD PRODUCT ENDPOINT - IMPROVED
app.post('/api/products', authenticateToken, async (req, res) => {
  try {
    const { name, category, purchase_price, selling_price, stock } = req.body;
    
    // Validate required fields
    if (!name || !category || !purchase_price || !selling_price) {
      return res.status(400).json({ 
        success: false, 
        error: 'Name, category, purchase price, and selling price are required' 
      });
    }
    
    const result = await pool.query(
      `INSERT INTO products (name, category, purchase_price, selling_price, stock) 
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [name, category, purchase_price, selling_price, stock || 0]
    );
    
    console.log('✅ Product added:', name);
    
    // Notify all clients about new product
    io.emit('product_updated', {
      type: 'created',
      product: result.rows[0],
      user: req.user.name
    });
    
    res.json({ success: true, product: result.rows[0] });
  } catch (error) {
    console.log('❌ Add product error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Update product stock
app.put('/api/products/:id/stock', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { stock } = req.body;
    
    const result = await pool.query(
      'UPDATE products SET stock = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING *',
      [stock, id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Product not found' });
    }
    
    // Notify all clients about stock update
    io.emit('product_updated', {
      type: 'stock_updated',
      product: result.rows[0],
      user: req.user.name
    });
    
    res.json({ success: true, product: result.rows[0] });
  } catch (error) {
    console.log('❌ Update stock error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// SALES ENDPOINTS

// Create new sale
app.post('/api/sales', authenticateToken, async (req, res) => {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    const { customer, items } = req.body;
    const total = items.reduce((sum, item) => sum + (item.quantity * item.unit_price), 0);
    
    // Create sale record
    const saleResult = await client.query(
      `INSERT INTO sales (date, customer, total, user_id) 
       VALUES (CURRENT_DATE, $1, $2, $3) RETURNING *`,
      [customer, total, req.user.id]
    );
    
    const sale = saleResult.rows[0];
    
    // Create sale items and update product stock
    for (const item of items) {
      // Add sale item
      await client.query(
        `INSERT INTO sale_items (sale_id, product_id, quantity, unit_price, total_price) 
         VALUES ($1, $2, $3, $4, $5)`,
        [sale.id, item.product_id, item.quantity, item.unit_price, item.quantity * item.unit_price]
      );
      
      // Update product stock
      await client.query(
        'UPDATE products SET stock = stock - $1 WHERE id = $2',
        [item.quantity, item.product_id]
      );
    }
    
    await client.query('COMMIT');
    
    // Notify all clients about new sale
    io.emit('sale_created', {
      sale: sale,
      items: items,
      user: req.user.name
    });
    
    res.json({ success: true, sale: sale });
    
  } catch (error) {
    await client.query('ROLLBACK');
    console.log('❌ Create sale error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  } finally {
    client.release();
  }
});

// Get all sales
app.get('/api/sales', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT s.*, u.full_name as user_name 
      FROM sales s 
      LEFT JOIN users u ON s.user_id = u.id 
      ORDER BY s.created_at DESC
    `);
    res.json({ success: true, sales: result.rows });
  } catch (error) {
    console.log('❌ Get sales error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// DASHBOARD STATS
app.get('/api/dashboard/stats', authenticateToken, async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    
    // Today's sales
    const todaySales = await pool.query(
      'SELECT COALESCE(SUM(total), 0) as total FROM sales WHERE date = $1',
      [today]
    );
    
    // Total products
    const totalProducts = await pool.query('SELECT COUNT(*) as count FROM products');
    
    // Low stock products
    const lowStock = await pool.query('SELECT COUNT(*) as count FROM products WHERE stock < 10');
    
    // Total users
    const totalUsers = await pool.query('SELECT COUNT(*) as count FROM users WHERE status = $1', ['active']);
    
    // Pending users count
    const pendingUsers = await pool.query('SELECT COUNT(*) as count FROM users WHERE status = $1', ['pending']);
    
    res.json({
      success: true,
      stats: {
        todaySales: parseFloat(todaySales.rows[0].total),
        totalProducts: parseInt(totalProducts.rows[0].count),
        lowStock: parseInt(lowStock.rows[0].count),
        totalUsers: parseInt(totalUsers.rows[0].count),
        pendingUsers: parseInt(pendingUsers.rows[0].count)
      }
    });
  } catch (error) {
    console.log('❌ Dashboard stats error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Serve frontend
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/public/index.html');
});

app.get('/login', (req, res) => {
  res.sendFile(__dirname + '/public/login.html');
});

app.get('/register', (req, res) => {
  res.sendFile(__dirname + '/public/register.html');
});

app.get('/dashboard', (req, res) => {
  res.sendFile(__dirname + '/public/dashboard.html');
});

// Health check endpoint
app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ 
      status: 'OK', 
      database: 'Connected',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ 
      status: 'ERROR', 
      database: 'Disconnected',
      error: error.message 
    });
  }
});

// Start server
initializeDatabase().then(() => {
  server.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`🌐 Website: http://localhost:${PORT}`);
    console.log(`📊 Database initialized successfully`);
    console.log(`🔧 Health check: http://localhost:${PORT}/health`);
  });
}).catch(error => {
  console.log('❌ Failed to start server:', error.message);
});

module.exports = app;