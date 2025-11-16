const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const pool = new Pool({
  connectionString: 'postgresql://neondb_owner:npg_5xuW7bCFOotA@ep-proud-frost-ad2na05y-pooler.c-2.us-east-1.aws.neon.tech/neondb?sslmode=require',
  ssl: { rejectUnauthorized: false }
});

async function testLogin() {
  try {
    const client = await pool.connect();
    
    // Check users in database
    const users = await client.query('SELECT * FROM users');
    console.log('👥 All users in database:');
    users.rows.forEach(user => {
      console.log(`- ${user.email} (${user.role}) - Status: ${user.status}`);
    });
    
    // Test login with existing user
    const testEmail = 'test2@test.com'; // Change to your test user email
    const userResult = await client.query('SELECT * FROM users WHERE email = $1', [testEmail]);
    
    if (userResult.rows.length > 0) {
      const user = userResult.rows[0];
      console.log('\n🔍 Testing login for:', user.email);
      console.log('📝 User status:', user.status);
      console.log('🔑 Password hash:', user.password.substring(0, 20) + '...');
      
      // Test password
      const testPassword = 'mypassword123'; // Change to your test password
      const valid = await bcrypt.compare(testPassword, user.password);
      console.log('✅ Password match:', valid);
    }
    
    client.release();
  } catch (error) {
    console.log('❌ Test error:', error.message);
  }
}

testLogin();