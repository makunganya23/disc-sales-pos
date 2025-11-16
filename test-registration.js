const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const pool = new Pool({
  connectionString: 'postgresql://neondb_owner:npg_5xuW7bCFOotA@ep-proud-frost-ad2na05y-pooler.c-2.us-east-1.aws.neon.tech/neondb?sslmode=require',
  ssl: { rejectUnauthorized: false }
});

async function testRegistration() {
  try {
    const client = await pool.connect();
    
    // Test new registration
    const hashedPassword = await bcrypt.hash('mypassword123', 10);
    const newUser = await client.query(
      `INSERT INTO users (full_name, email, password, role, status) 
       VALUES ($1, $2, $3, $4, $5) RETURNING id, full_name, email, role, status`,
      ['Test User 2', 'test2@test.com', hashedPassword, 'cashier', 'active']
    );
    
    console.log('✅ REGISTRATION SUCCESSFUL:', newUser.rows[0]);
    client.release();
    
  } catch (error) {
    console.log('❌ Registration test failed:', error.message);
  }
}

testRegistration();