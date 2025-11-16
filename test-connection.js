const { Pool } = require('pg');

console.log('🔗 Testing database connection...');

const pool = new Pool({
  connectionString: 'postgresql://neondb_owner:npg_l6xbM3vaWeNZ@ep-weathered-pond-a4v7ua86-pooler.us-east-1.aws.neon.tech/neondb?sslmode=require',
  ssl: { rejectUnauthorized: false }
});

async function testConnection() {
  try {
    const client = await pool.connect();
    console.log('✅ Database connected successfully!');
    
    // Test simple query
    const result = await client.query('SELECT NOW() as current_time');
    console.log('🕐 Database time:', result.rows[0].current_time);
    
    client.release();
    process.exit(0);
  } catch (error) {
    console.log('❌ Database connection failed:');
    console.log('Error:', error.message);
    process.exit(1);
  }
}

testConnection();