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
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        logged_as_meal BOOLEAN DEFAULT false,
        meal_date TIMESTAMP,
        recipe_name VARCHAR(255)
      )
    `);
    
    // Add columns to existing tables if they don't exist
    await pool.query(`
      DO $$ 
      BEGIN
        BEGIN
          ALTER TABLE orders ADD COLUMN logged_as_meal BOOLEAN DEFAULT false;
        EXCEPTION
          WHEN duplicate_column THEN NULL;
        END;
        
        BEGIN
          ALTER TABLE orders ADD COLUMN meal_date TIMESTAMP;
        EXCEPTION
          WHEN duplicate_column THEN NULL;
        END;
        
        BEGIN
          ALTER TABLE orders ADD COLUMN recipe_name VARCHAR(255);
        EXCEPTION
          WHEN duplicate_column THEN NULL;
        END;
      END $$;
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
        tags TEXT[], 
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
