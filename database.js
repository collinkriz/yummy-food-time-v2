const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Initialize unified database tables
async function initializeDatabase() {
  try {
    // Create unified meals table (replaces orders table)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS meals (
        id SERIAL PRIMARY KEY,
        meal_type VARCHAR(20) NOT NULL CHECK (meal_type IN ('takeout', 'recipe')),
        name VARCHAR(255) NOT NULL,
        
        -- Takeout-specific fields
        restaurant VARCHAR(255),
        address TEXT,
        delivery_service VARCHAR(100),
        subtotal DECIMAL(10, 2),
        delivery_fee DECIMAL(10, 2),
        service_fee DECIMAL(10, 2),
        tax DECIMAL(10, 2),
        discount DECIMAL(10, 2),
        tip DECIMAL(10, 2),
        total DECIMAL(10, 2),
        
        -- Recipe-specific fields
        prep_time VARCHAR(50),
        cook_time VARCHAR(50),
        total_time VARCHAR(50),
        servings VARCHAR(50),
        ingredients TEXT,
        directions TEXT,
        notes TEXT,
        source_url TEXT,
        photo_url TEXT,
        
        -- Common fields for both
        meal_date TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        overall_rating INTEGER CHECK (overall_rating >= 0 AND overall_rating <= 5),
        tags TEXT[]
      )
    `);

    // Create meal_items table (replaces order_items, works for both takeout items and recipe components)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS meal_items (
        id SERIAL PRIMARY KEY,
        meal_id INTEGER REFERENCES meals(id) ON DELETE CASCADE,
        item_name TEXT NOT NULL,
        
        -- Takeout-specific
        price DECIMAL(10, 2),
        assigned_to VARCHAR(50),
        
        -- Common fields
        rating INTEGER CHECK (rating >= 0 AND rating <= 5),
        notes TEXT,
        tags TEXT[],
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create AI usage tracking table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ai_usage (
        id SERIAL PRIMARY KEY,
        feature VARCHAR(50) NOT NULL,
        estimated_cost DECIMAL(10, 4) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create indexes for better performance
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_meals_type ON meals(meal_type);
      CREATE INDEX IF NOT EXISTS idx_meals_date ON meals(meal_date);
      CREATE INDEX IF NOT EXISTS idx_meals_tags ON meals USING GIN(tags);
      CREATE INDEX IF NOT EXISTS idx_meal_items_meal_id ON meal_items(meal_id);
      CREATE INDEX IF NOT EXISTS idx_ai_usage_created_at ON ai_usage(created_at);
      CREATE INDEX IF NOT EXISTS idx_ai_usage_feature ON ai_usage(feature);
    `);

    console.log('✅ Unified database tables initialized successfully');
  } catch (error) {
    console.error('Error initializing database:', error);
    throw error;
  }
}

// Migration function to move existing orders to new meals table
async function migrateExistingData() {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    // Check if old tables exist
    const tablesExist = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_name = 'orders'
      ) as orders_exists,
      EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_name = 'order_items'
      ) as order_items_exists
    `);
    
    if (tablesExist.rows[0].orders_exists) {
      console.log('📦 Migrating existing takeout orders...');
      
      // Migrate orders to meals
      await client.query(`
        INSERT INTO meals (
          meal_type, name, restaurant, address, delivery_service,
          subtotal, delivery_fee, service_fee, tax, discount, tip, total,
          meal_date, created_at, tags
        )
        SELECT 
          'takeout' as meal_type,
          COALESCE(recipe_name, restaurant) as name,
          restaurant, address, delivery_service,
          subtotal, delivery_fee, service_fee, tax, discount, tip, total,
          COALESCE(meal_date, order_date) as meal_date,
          created_at,
          ARRAY[]::TEXT[] as tags
        FROM orders
      `);
      
      if (tablesExist.rows[0].order_items_exists) {
        // Migrate order_items to meal_items
        await client.query(`
          INSERT INTO meal_items (
            meal_id, item_name, price, assigned_to, rating, notes, tags
          )
          SELECT 
            m.id as meal_id,
            oi.item_name, oi.price, oi.assigned_to, oi.rating, oi.notes, 
            COALESCE(oi.tags, ARRAY[]::TEXT[]) as tags
          FROM order_items oi
          JOIN orders o ON oi.order_id = o.id
          JOIN meals m ON m.restaurant = o.restaurant 
            AND m.created_at = o.created_at
            AND m.meal_type = 'takeout'
        `);
      }
      
      console.log('✅ Migration complete!');
      
      // Rename old tables instead of dropping (safety first!)
      await client.query('ALTER TABLE IF EXISTS orders RENAME TO orders_backup');
      await client.query('ALTER TABLE IF EXISTS order_items RENAME TO order_items_backup');
      console.log('📁 Old tables renamed to *_backup for safety');
    }
    
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Migration failed:', error);
    throw error;
  } finally {
    client.release();
  }
}

// Function to import recipes from JSON into database
async function importRecipes(recipesData) {
  const client = await pool.connect();
  let imported = 0;
  let skipped = 0;
  
  try {
    console.log(`📚 Importing ${recipesData.length} recipes...`);
    
    for (const recipe of recipesData) {
      try {
        await client.query(`
          INSERT INTO meals (
            meal_type, name, prep_time, cook_time, total_time, servings,
            ingredients, directions, notes, source_url, photo_url, tags, created_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        `, [
          'recipe',
          recipe.name,
          recipe.prep_time,
          recipe.cook_time,
          recipe.total_time,
          recipe.servings,
          recipe.ingredients,
          recipe.directions,
          recipe.notes,
          recipe.source_url,
          recipe.photo_url,
          recipe.tags || recipe.ai_category || [],
          new Date()
        ]);
        imported++;
      } catch (error) {
        if (error.code === '23505') { // Duplicate
          skipped++;
        } else {
          console.error(`Error importing ${recipe.name}:`, error.message);
        }
      }
    }
    
    console.log(`✅ Imported ${imported} recipes, skipped ${skipped} duplicates`);
  } catch (error) {
    console.error('❌ Recipe import failed:', error);
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { pool, initializeDatabase, migrateExistingData, importRecipes };
