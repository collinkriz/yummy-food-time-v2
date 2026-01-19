const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Initialize database tables
async function initializeDatabase() {
  try {
    // Create orders table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS orders (
        id SERIAL PRIMARY KEY,
        restaurant VARCHAR(255) NOT NULL,
        address TEXT,
        delivery_service VARCHAR(100),
        subtotal DECIMAL(10, 2),
        delivery_fee DECIMAL(10, 2),
        service_fee DECIMAL(10, 2),
        tax DECIMAL(10, 2),
        discount DECIMAL(10, 2),
        tip DECIMAL(10, 2),
        total DECIMAL(10, 2),
        order_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create order_items table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS order_items (
        id SERIAL PRIMARY KEY,
        order_id INTEGER REFERENCES orders(id) ON DELETE CASCADE,
        item_name TEXT NOT NULL,
        price DECIMAL(10, 2),
        assigned_to VARCHAR(50),
        rating INTEGER CHECK (rating >= 0 AND rating <= 5),
        notes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    console.log('Database tables initialized successfully');
  } catch (error) {
    console.error('Error initializing database:', error);
    throw error;
  }
}

module.exports = { pool, initializeDatabase };
