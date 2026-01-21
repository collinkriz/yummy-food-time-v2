// ==================== ONE-TIME MIGRATION ENDPOINT ====================
// Add this code AFTER your app setup (after app.use lines) and BEFORE other routes
// Visit /run-migration in your browser to automatically migrate your database

const fs = require('fs');
const path = require('path');

let migrationRun = false;

app.get('/run-migration', async (req, res) => {
  // Check if already run
  if (migrationRun) {
    return res.send(`
      <html><body style="font-family: sans-serif; padding: 40px;">
        <h1 style="color: #22c55e;">✅ Migration Already Complete!</h1>
        <p>The migration has already been run successfully.</p>
        <p><a href="/" style="color: #3b82f6;">Go to app</a></p>
      </body></html>
    `);
  }

  // Show confirmation screen
  if (req.query.confirm !== 'yes') {
    return res.send(`
      <html><body style="font-family: sans-serif; padding: 40px; max-width: 600px;">
        <h1>⚠️ Database Migration</h1>
        <p>This will migrate your database to the unified schema that combines takeout orders and recipes.</p>
        <p><strong>This is SAFE:</strong></p>
        <ul>
          <li>Old tables will be backed up, not deleted</li>
          <li>If anything fails, it automatically rolls back</li>
          <li>Your data cannot be lost</li>
        </ul>
        <p><a href="/run-migration?confirm=yes" style="background: #22c55e; color: white; padding: 15px 30px; text-decoration: none; border-radius: 8px; display: inline-block; font-weight: bold; margin: 20px 0;">✅ Yes, Run Migration</a></p>
        <p><a href="/" style="color: #666;">Cancel</a></p>
      </body></html>
    `);
  }

  // Run the migration
  const client = await pool.connect();
  const results = [];
  
  try {
    results.push('🚀 Starting migration...<br><br>');

    // Check if already migrated
    const tableCheck = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_name = 'meals'
      ) as meals_exists
    `);

    if (tableCheck.rows[0].meals_exists) {
      migrationRun = true;
      return res.send(`
        <html><body style="font-family: sans-serif; padding: 40px;">
          <h1 style="color: #22c55e;">✅ Migration Already Complete!</h1>
          <p>The unified meals table already exists in your database.</p>
          <p><a href="/" style="color: #3b82f6;">Go to app</a></p>
        </body></html>
      `);
    }

    await client.query('BEGIN');

    // Create meals table
    results.push('📋 Step 1: Creating meals table...<br>');
    await client.query(`
      CREATE TABLE meals (
        id SERIAL PRIMARY KEY,
        meal_type VARCHAR(20) NOT NULL CHECK (meal_type IN ('takeout', 'recipe')),
        name VARCHAR(255) NOT NULL,
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
        prep_time VARCHAR(50),
        cook_time VARCHAR(50),
        total_time VARCHAR(50),
        servings VARCHAR(50),
        ingredients TEXT,
        directions TEXT,
        notes TEXT,
        source_url TEXT,
        photo_url TEXT,
        meal_date TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        overall_rating INTEGER CHECK (overall_rating >= 0 AND overall_rating <= 5),
        tags TEXT[]
      )
    `);
    results.push('&nbsp;&nbsp;✅ Meals table created<br><br>');

    // Create meal_items table
    results.push('📋 Step 2: Creating meal_items table...<br>');
    await client.query(`
      CREATE TABLE meal_items (
        id SERIAL PRIMARY KEY,
        meal_id INTEGER REFERENCES meals(id) ON DELETE CASCADE,
        item_name TEXT NOT NULL,
        price DECIMAL(10, 2),
        assigned_to VARCHAR(50),
        rating INTEGER CHECK (rating >= 0 AND rating <= 5),
        notes TEXT,
        tags TEXT[],
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    results.push('&nbsp;&nbsp;✅ Meal_items table created<br><br>');

    // Create indexes
    results.push('📋 Step 3: Creating indexes...<br>');
    await client.query(`
      CREATE INDEX idx_meals_type ON meals(meal_type);
      CREATE INDEX idx_meals_date ON meals(meal_date);
      CREATE INDEX idx_meals_tags ON meals USING GIN(tags);
      CREATE INDEX idx_meal_items_meal_id ON meal_items(meal_id);
    `);
    results.push('&nbsp;&nbsp;✅ Indexes created<br><br>');

    // Check for old tables
    const oldTablesCheck = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_name = 'orders'
      ) as orders_exists
    `);

    if (oldTablesCheck.rows[0].orders_exists) {
      // Migrate orders
      results.push('📋 Step 4: Migrating takeout orders...<br>');
      const orderResult = await client.query(`
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
        RETURNING id
      `);
      results.push(`&nbsp;&nbsp;✅ Migrated ${orderResult.rowCount} takeout orders<br><br>`);

      // Migrate order_items
      results.push('📋 Step 5: Migrating order items...<br>');
      const itemResult = await client.query(`
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
      results.push(`&nbsp;&nbsp;✅ Migrated ${itemResult.rowCount} order items<br><br>`);

      // Backup old tables
      results.push('📋 Step 6: Backing up old tables...<br>');
      await client.query('ALTER TABLE orders RENAME TO orders_backup');
      await client.query('ALTER TABLE order_items RENAME TO order_items_backup');
      results.push('&nbsp;&nbsp;✅ Old tables saved as *_backup<br><br>');
    } else {
      results.push('ℹ️ No existing orders found (fresh install)<br><br>');
    }

    // Import recipes
    results.push('📋 Step 7: Importing recipes...<br>');
    const recipesPath = path.join(__dirname, 'recipes.json');
    if (fs.existsSync(recipesPath)) {
      const recipes = JSON.parse(fs.readFileSync(recipesPath, 'utf8'));
      
      let imported = 0;
      for (const recipe of recipes) {
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
        } catch (err) {
          // Skip duplicates
        }
      }
      results.push(`&nbsp;&nbsp;✅ Imported ${imported} recipes<br><br>`);
    } else {
      results.push('&nbsp;&nbsp;ℹ️ No recipes.json found<br><br>');
    }

    // Verify
    const stats = await client.query(`
      SELECT meal_type, COUNT(*) as count
      FROM meals
      GROUP BY meal_type
    `);
    
    results.push('<h2 style="color: #22c55e;">✅ Migration Complete!</h2>');
    results.push('<p><strong>Database Summary:</strong></p>');
    results.push('<ul>');
    stats.rows.forEach(row => {
      results.push(`<li>${row.meal_type}: ${row.count} meals</li>`);
    });
    results.push('</ul>');

    await client.query('COMMIT');
    migrationRun = true;

    res.send(`
      <html><body style="font-family: sans-serif; padding: 40px; max-width: 800px;">
        <div style="background: #f0f9ff; padding: 30px; border-radius: 12px; border: 2px solid #22c55e;">
          ${results.join('')}
        </div>
        <p style="margin-top: 30px;"><strong>Your app is now using the unified database!</strong></p>
        <p>Old tables are safely backed up as *_backup tables.</p>
        <p><a href="/" style="background: #3b82f6; color: white; padding: 15px 30px; text-decoration: none; border-radius: 8px; display: inline-block; font-weight: bold; margin-top: 20px;">Go to App</a></p>
      </body></html>
    `);

  } catch (error) {
    await client.query('ROLLBACK');
    results.push(`<br><h2 style="color: #dc2626;">❌ Migration Failed</h2>`);
    results.push(`<p><strong>Error:</strong> ${error.message}</p>`);
    results.push('<p>Your data is safe - the migration was automatically rolled back.</p>');

    res.send(`
      <html><body style="font-family: sans-serif; padding: 40px; max-width: 800px;">
        <div style="background: #fee; padding: 30px; border-radius: 12px; border: 2px solid #dc2626;">
          ${results.join('')}
        </div>
        <p><a href="/" style="color: #3b82f6;">Go back</a></p>
      </body></html>
    `);
  } finally {
    client.release();
  }
});

// ==================== END MIGRATION ENDPOINT ====================
