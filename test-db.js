require('dotenv').config();
console.log('🔍 Checking database connection...');
console.log('Database URL exists:', !!process.env.DATABASE_URL);
console.log('First part:', process.env.DATABASE_URL?.split('@')[0]);