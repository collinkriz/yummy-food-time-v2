const express = require('express');
const multer = require('multer');
const cors = require('cors');
const { pool, initializeDatabase } = require('./database');
const fs = require('fs');
const path = require('path');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Initialize database on startup
initializeDatabase().catch(console.error);

// ==================== ONE-TIME MIGRATION ENDPOINT ====================
let migrationRun = false;

app.get('/run-migration', async (req, res) => {
  if (migrationRun) {
    return res.send(`
      <html><body style="font-family: sans-serif; padding: 40px;">
        <h1 style="color: #22c55e;">✅ Migration Already Complete!</h1>
        <p>The migration has already been run successfully.</p>
        <p><a href="/" style="color: #3b82f6;">Go to app</a></p>
      </body></html>
    `);
  }

  if (req.query.confirm !== 'yes') {
    return res.send(`
      <html><body style="font-family: sans-serif; padding: 40px; max-width: 600px;">
        <h1>⚠️ Database Migration</h1>
        <p>This will migrate your database to the unified schema.</p>
        <p><strong>This is SAFE:</strong></p>
        <ul>
          <li>Old tables will be backed up, not deleted</li>
          <li>If anything fails, it automatically rolls back</li>
        </ul>
        <p><a href="/run-migration?confirm=yes" style="background: #22c55e; color: white; padding: 15px 30px; text-decoration: none; border-radius: 8px; display: inline-block; font-weight: bold; margin: 20px 0;">✅ Yes, Run Migration</a></p>
        <p><a href="/" style="color: #666;">Cancel</a></p>
      </body></html>
    `);
  }

  const client = await pool.connect();
  const results = [];
  
  try {
    results.push('🚀 Starting migration...<br><br>');

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
          <p>The unified meals table already exists.</p>
          <p><a href="/" style="color: #3b82f6;">Go to app</a></p>
        </body></html>
      `);
    }

    await client.query('BEGIN');

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

    results.push('📋 Step 3: Creating indexes...<br>');
    await client.query(`
      CREATE INDEX idx_meals_type ON meals(meal_type);
      CREATE INDEX idx_meals_date ON meals(meal_date);
      CREATE INDEX idx_meals_tags ON meals USING GIN(tags);
      CREATE INDEX idx_meal_items_meal_id ON meal_items(meal_id);
    `);
    results.push('&nbsp;&nbsp;✅ Indexes created<br><br>');

    const oldTablesCheck = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_name = 'orders'
      ) as orders_exists
    `);

    if (oldTablesCheck.rows[0].orders_exists) {
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

      results.push('📋 Step 6: Backing up old tables...<br>');
      await client.query('ALTER TABLE orders RENAME TO orders_backup');
      await client.query('ALTER TABLE order_items RENAME TO order_items_backup');
      results.push('&nbsp;&nbsp;✅ Old tables saved as *_backup<br><br>');
    } else {
      results.push('ℹ️ No existing orders found<br><br>');
    }

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
    results.push('<p>Your data is safe - migration rolled back.</p>');

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

// ==================== IMPORT RECIPES ENDPOINT ====================
// One-time import of recipes from recipes.json into database
// Visit: /import-recipes
app.get('/import-recipes', async (req, res) => {
  const client = await pool.connect();
  const results = [];
  
  try {
    results.push('📚 Starting recipe import...<br><br>');
    
    const recipesPath = path.join(__dirname, 'recipes.json');
    if (!fs.existsSync(recipesPath)) {
      return res.send(`
        <html><body style="font-family: sans-serif; padding: 40px;">
          <h1 style="color: #dc2626;">❌ recipes.json Not Found</h1>
          <p>Make sure recipes.json is in the root directory of your project.</p>
          <p><a href="/">Go back</a></p>
        </body></html>
      `);
    }
    
    const recipes = JSON.parse(fs.readFileSync(recipesPath, 'utf8'));
    results.push(`📋 Found ${recipes.length} recipes in JSON file<br><br>`);
    
    let imported = 0;
    let skipped = 0;
    
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
        if (err.code === '23505') {
          skipped++;
        } else {
          console.error(`Error importing ${recipe.name}:`, err.message);
        }
      }
    }
    
    results.push(`<h2 style="color: #22c55e;">✅ Import Complete!</h2>`);
    results.push(`<p>Imported: ${imported} recipes</p>`);
    results.push(`<p>Skipped (duplicates): ${skipped} recipes</p>`);
    
    res.send(`
      <html><body style="font-family: sans-serif; padding: 40px; max-width: 800px;">
        <div style="background: #f0f9ff; padding: 30px; border-radius: 12px; border: 2px solid #22c55e;">
          ${results.join('')}
        </div>
        <p><a href="/" style="background: #3b82f6; color: white; padding: 15px 30px; text-decoration: none; border-radius: 8px; display: inline-block; font-weight: bold; margin-top: 20px;">Go to App</a></p>
      </body></html>
    `);
    
  } catch (error) {
    results.push(`<br><h2 style="color: #dc2626;">❌ Import Failed</h2>`);
    results.push(`<p><strong>Error:</strong> ${error.message}</p>`);
    
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
// ==================== END IMPORT RECIPES ENDPOINT ====================

// ==================== TAG ALL RECIPES ENDPOINT ====================
// AI-powered tagging of all recipes in database
// Visit: /run-tagging
let taggingInProgress = false;

app.get('/run-tagging', async (req, res) => {
  if (taggingInProgress) {
    return res.send(`
      <html><body style="font-family: sans-serif; padding: 40px;">
        <h1 style="color: #f59e0b;">⏳ Tagging In Progress!</h1>
        <p>The tagging process is already running. Please wait...</p>
        <p><a href="/" style="color: #3b82f6;">Go to app</a></p>
      </body></html>
    `);
  }

  if (req.query.confirm !== 'yes') {
    return res.send(`
      <html><body style="font-family: sans-serif; padding: 40px; max-width: 700px;">
        <h1>🏷️ AI Recipe Tagging</h1>
        <p>This will tag all 162 recipes with comprehensive AI-generated tags.</p>
        <p><strong>Details:</strong></p>
        <ul>
          <li>Uses Claude API to analyze each recipe</li>
          <li>Generates 4-8 tags per recipe (Course, Time, Difficulty, Cuisine, etc.)</li>
          <li>Processes ONE recipe at a time (slower but more reliable)</li>
          <li>Takes ~20-25 minutes</li>
          <li>Costs ~$1-2 in API credits</li>
          <li>Updates database directly</li>
        </ul>
        <p><a href="/run-tagging?confirm=yes" style="background: #667eea; color: white; padding: 15px 30px; text-decoration: none; border-radius: 8px; display: inline-block; font-weight: bold; margin: 20px 0;">✨ Yes, Tag All Recipes</a></p>
        <p><a href="/" style="color: #666;">Cancel</a></p>
      </body></html>
    `);
  }

  // Set flag to prevent concurrent runs
  taggingInProgress = true;

  // Set headers for streaming response
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Transfer-Encoding', 'chunked');
  
  res.write(`
    <html>
    <head>
      <style>
        body { font-family: monospace; padding: 40px; background: #1e1e1e; color: #d4d4d4; }
        .success { color: #4ade80; }
        .error { color: #f87171; }
        .info { color: #60a5fa; }
        .batch { color: #fbbf24; font-weight: bold; margin-top: 20px; }
      </style>
    </head>
    <body>
      <h1 style="color: #667eea;">🏷️ AI Recipe Tagging (Slow & Steady Mode)</h1>
      <pre>
  `);

  const startTime = Date.now();
  let successCount = 0;
  let errorCount = 0;

  try {
    res.write(`<span class="info">📋 Fetching recipes from database...</span>\n`);
    
    const result = await pool.query(`
      SELECT id, name, ingredients, directions, prep_time, cook_time, servings, tags
      FROM meals
      WHERE meal_type = 'recipe'
      ORDER BY name ASC
    `);
    
    const recipes = result.rows;
    res.write(`<span class="success">✅ Found ${recipes.length} recipes</span>\n\n`);
    res.write(`<span class="info">🐢 Processing ONE recipe at a time with 1 second delay between each...</span>\n\n`);

    // Process ONE recipe at a time
    for (let i = 0; i < recipes.length; i++) {
      const recipe = recipes[i];
      const recipeNum = i + 1;
      const recipeName = recipe.name.substring(0, 45).padEnd(45);
      
      // Show progress every 10 recipes
      if (i % 10 === 0) {
        res.write(`<span class="batch">📦 Progress: ${i + 1}/${recipes.length}</span>\n`);
      }
      
      try {
        const prompt = `Analyze this recipe and assign appropriate tags. Choose tags that accurately describe this recipe based on reading the full content.

**Recipe Name:** ${recipe.name}
**Ingredients:** ${recipe.ingredients || 'N/A'}
**Directions:** ${recipe.directions ? recipe.directions.substring(0, 1000) : 'N/A'}
**Prep Time:** ${recipe.prep_time || 'N/A'}
**Cook Time:** ${recipe.cook_time || 'N/A'}
**Servings:** ${recipe.servings || 'N/A'}

**Available Tags by Category:**
Meal Type: Breakfast, Lunch, Dinner, Brunch, Snack
Course: Appetizer, Main Dish, Side Dish, Salad, Soup, Dessert, Beverage, Sauce/Condiment
Dietary: Vegetarian, Vegan, Gluten-Free, Dairy-Free, Nut-Free, Low-Carb, Keto, Paleo
Cuisine: American, Italian, Mexican, Asian, Indian, Mediterranean, French, Thai, Korean, Japanese, Chinese, Greek, Middle Eastern
Cooking Method: Baked, Grilled, Fried, Slow Cooker, Instant Pot, One-Pot, No-Cook, Roasted, Sautéed, Steamed
Time: Quick (< 30 min), Medium (30-60 min), Long (> 60 min)
Difficulty: Easy, Medium, Hard
Characteristics: Healthy, Comfort Food, Kid-Friendly, Party Food, Make-Ahead, Meal Prep, Spicy, Sweet, Savory, Fresh, Hearty, Light

Return ONLY a JSON array of 4-8 selected tags. Include at least one from: Course, Time, Difficulty.

Example: ["Dessert", "Quick (< 30 min)", "Easy", "Sweet"]`;

        const response = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': process.env.ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01'
          },
          body: JSON.stringify({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 200,
            messages: [{ role: 'user', content: prompt }]
          })
        });

        const data = await response.json();
        
        if (!response.ok) {
          throw new Error(data.error?.message || `API error: ${response.status}`);
        }
        
        const text = data.content[0].text.trim();
        const tagsMatch = text.match(/\[.*\]/s);
        
        if (tagsMatch) {
          const tags = JSON.parse(tagsMatch[0]);
          await pool.query(
            'UPDATE meals SET tags = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
            [tags, recipe.id]
          );
          successCount++;
          res.write(`  <span class="success">[${recipeNum}/${recipes.length}] ${recipeName} ✅ ${tags.length} tags</span>\n`);
        } else {
          errorCount++;
          res.write(`  <span class="error">[${recipeNum}/${recipes.length}] ${recipeName} ⚠️  parse failed</span>\n`);
        }
      } catch (error) {
        errorCount++;
        res.write(`  <span class="error">[${recipeNum}/${recipes.length}] ${recipeName} ❌ ${error.message.substring(0, 30)}</span>\n`);
      }
      
      // 1 second delay between each recipe
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    const duration = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
    
    res.write(`\n<span class="success">✅ Tagging complete in ${duration} minutes!</span>\n`);
    res.write(`<span class="info">   Success: ${successCount} recipes</span>\n`);
    res.write(`<span class="info">   Errors: ${errorCount} recipes</span>\n\n`);
    
    // Show tag statistics
    res.write(`<span class="info">📊 Top 20 Tags:</span>\n`);
    const stats = await pool.query(`
      SELECT unnest(tags) as tag, COUNT(*) as count
      FROM meals
      WHERE meal_type = 'recipe' AND tags IS NOT NULL
      GROUP BY tag
      ORDER BY count DESC
      LIMIT 20
    `);
    
    stats.rows.forEach(row => {
      res.write(`   ${row.tag}: ${row.count}\n`);
    });

    res.write(`
      </pre>
      <p style="margin-top: 30px;"><a href="/" style="background: #3b82f6; color: white; padding: 15px 30px; text-decoration: none; border-radius: 8px; display: inline-block; font-weight: bold;">Go to App</a></p>
    </body></html>
    `);
    
  } catch (error) {
    res.write(`\n<span class="error">❌ Fatal Error: ${error.message}</span>\n`);
    res.write(`
      </pre>
      <p><a href="/">Go back</a></p>
    </body></html>
    `);
  } finally {
    taggingInProgress = false;
    res.end();
  }
});
// ==================== END TAG ALL RECIPES ENDPOINT ====================

// ==================== TEST TAGGING ENDPOINT ====================
// Test tagging a single recipe to debug issues
app.get('/test-tagging', async (req, res) => {
  try {
    // Get one recipe
    const result = await pool.query(`
      SELECT id, name, ingredients, directions, prep_time, cook_time, servings
      FROM meals
      WHERE meal_type = 'recipe'
      LIMIT 1
    `);
    
    if (result.rows.length === 0) {
      return res.json({ error: 'No recipes found' });
    }
    
    const recipe = result.rows[0];
    
    const prompt = `Analyze this recipe and assign appropriate tags. Return ONLY a JSON array of 4-8 tags.

Recipe: ${recipe.name}
Ingredients: ${recipe.ingredients?.substring(0, 200) || 'N/A'}

Available tags: Dessert, Main Dish, Quick (< 30 min), Easy, Vegetarian, Italian, Baked

Example: ["Dessert", "Quick (< 30 min)", "Easy"]`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 200,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const data = await response.json();
    
    res.json({
      success: response.ok,
      status: response.status,
      recipe: recipe.name,
      apiKey: process.env.ANTHROPIC_API_KEY ? 'Present (first 10 chars): ' + process.env.ANTHROPIC_API_KEY.substring(0, 10) : 'Missing!',
      response: data
    });
    
  } catch (error) {
    res.json({ error: error.message, stack: error.stack });
  }
});
// ==================== END TEST TAGGING ENDPOINT ====================

// Extract order info endpoint
app.post('/extract-order', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No image uploaded' });
    }

    console.log('Image received:', req.file.mimetype, req.file.size, 'bytes');
    const base64Image = req.file.buffer.toString('base64');

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        messages: [{
          role: 'user',
          content: [{
            type: 'image',
            source: { type: 'base64', media_type: req.file.mimetype, data: base64Image }
          }, {
            type: 'text',
            text: `You are extracting order information from a food delivery receipt image. Look very carefully at ALL text in the image.

CRITICAL: Look for the restaurant address in these common locations:
- Near the restaurant name at the top
- In a section labeled "Address:", "Location:", "Delivered to:", or "Restaurant address:"
- Near map icons or location pins
- In the delivery details section
- Sometimes it's in smaller text below the restaurant name

Extract this information and respond with ONLY a JSON object (no markdown, no backticks, no preamble):

{
  "restaurant": "exact restaurant name from receipt",
  "address": "full street address of the restaurant if visible, or 'Not visible' only if you truly cannot find it anywhere",
  "deliveryService": "DoorDash, Uber Eats, Grubhub, Postmates, etc. - check the logo/branding",
  "items": [{ "name": "item name with customizations", "price": 0.00 }],
  "subtotal": 0.00,
  "deliveryFee": 0.00,
  "serviceFee": 0.00,
  "tax": 0.00,
  "discount": 0.00,
  "tip": 0.00,
  "total": 0.00
}

Look at EVERY section of the receipt carefully. The address is often near the top with the restaurant name, or in a delivery details section. Search thoroughly before saying "Not visible".`
          }]
        }]
      })
    });

    const data = await response.json();
    if (!response.ok) {
      console.error('Claude API error:', data);
      return res.status(response.status).json({ error: data.error?.message || 'Claude API error', details: data });
    }

    const text = data.content.filter(item => item.type === 'text').map(item => item.text).join('\n').trim();
    console.log('Claude response:', text);
    const cleanText = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const orderData = JSON.parse(cleanText);
    res.json({ success: true, data: orderData });

  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: error.message, stack: process.env.NODE_ENV === 'development' ? error.stack : undefined });
  }
});

// Save order to database
app.post('/orders', async (req, res) => {
  const client = await pool.connect();
  try {
    console.log('Received order data:', JSON.stringify(req.body, null, 2));
    const { restaurant, address, deliveryService, subtotal, deliveryFee, serviceFee, tax, discount, tip, total, items } = req.body;

    if (!restaurant || !items || items.length === 0) {
      throw new Error('Restaurant and items are required');
    }

    await client.query('BEGIN');
    const orderResult = await client.query(
      `INSERT INTO orders (restaurant, address, delivery_service, subtotal, delivery_fee, service_fee, tax, discount, tip, total)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [restaurant, address || 'Not provided', deliveryService || 'Unknown', subtotal || 0, deliveryFee || 0, serviceFee || 0, tax || 0, discount || 0, tip || 0, total || 0]
    );

    const orderId = orderResult.rows[0].id;
    for (const item of items) {
      await client.query(
        `INSERT INTO order_items (order_id, item_name, price, assigned_to, rating, notes)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [orderId, item.name, item.price || 0, item.assignedTo || null, item.rating || 0, item.notes || null]
      );
    }

    await client.query('COMMIT');
    console.log('Order saved successfully with ID:', orderId);
    res.json({ success: true, orderId });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error saving order:', error);
    res.status(500).json({ error: error.message, details: error.stack });
  } finally {
    client.release();
  }
});

// Get all orders
app.get('/orders', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT o.*, json_agg(json_build_object('id', oi.id, 'name', oi.item_name, 'price', oi.price, 'assignedTo', oi.assigned_to, 'rating', oi.rating, 'notes', oi.notes) ORDER BY oi.id) as items
      FROM orders o
      LEFT JOIN order_items oi ON o.id = oi.order_id
      GROUP BY o.id
      ORDER BY o.created_at DESC
    `);
    res.json({ success: true, orders: result.rows });
  } catch (error) {
    console.error('Error fetching orders:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get single order
app.get('/orders/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(`
      SELECT o.*, json_agg(json_build_object('id', oi.id, 'name', oi.item_name, 'price', oi.price, 'assignedTo', oi.assigned_to, 'rating', oi.rating, 'notes', oi.notes) ORDER BY oi.id) as items
      FROM orders o
      LEFT JOIN order_items oi ON o.id = oi.order_id
      WHERE o.id = $1
      GROUP BY o.id
    `, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }
    res.json({ success: true, order: result.rows[0] });
  } catch (error) {
    console.error('Error fetching order:', error);
    res.status(500).json({ error: error.message });
  }
});

// Update order item
app.patch('/order-items/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { rating, assignedTo, notes, tags } = req.body;
    const updates = [];
    const values = [];
    let paramCount = 1;

    if (rating !== undefined) { updates.push(`rating = $${paramCount++}`); values.push(rating); }
    if (assignedTo !== undefined) { updates.push(`assigned_to = $${paramCount++}`); values.push(assignedTo); }
    if (notes !== undefined) { updates.push(`notes = $${paramCount++}`); values.push(notes); }
    if (tags !== undefined) { updates.push(`tags = $${paramCount++}`); values.push(tags); }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    values.push(id);
    const query = `UPDATE order_items SET ${updates.join(', ')} WHERE id = $${paramCount} RETURNING *`;
    const result = await pool.query(query, values);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Item not found' });
    }
    res.json({ success: true, item: result.rows[0] });
  } catch (error) {
    console.error('Error updating order item:', error);
    res.status(500).json({ error: error.message });
  }
});

// Update entire order
app.patch('/orders/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { restaurant, address, deliveryService, subtotal, deliveryFee, serviceFee, tax, discount, tip, total } = req.body;
    const updates = [];
    const values = [];
    let paramCount = 1;

    if (restaurant !== undefined) { updates.push(`restaurant = $${paramCount++}`); values.push(restaurant); }
    if (address !== undefined) { updates.push(`address = $${paramCount++}`); values.push(address); }
    if (deliveryService !== undefined) { updates.push(`delivery_service = $${paramCount++}`); values.push(deliveryService); }
    if (subtotal !== undefined) { updates.push(`subtotal = $${paramCount++}`); values.push(subtotal); }
    if (deliveryFee !== undefined) { updates.push(`delivery_fee = $${paramCount++}`); values.push(deliveryFee); }
    if (serviceFee !== undefined) { updates.push(`service_fee = $${paramCount++}`); values.push(serviceFee); }
    if (tax !== undefined) { updates.push(`tax = $${paramCount++}`); values.push(tax); }
    if (discount !== undefined) { updates.push(`discount = $${paramCount++}`); values.push(discount); }
    if (tip !== undefined) { updates.push(`tip = $${paramCount++}`); values.push(tip); }
    if (total !== undefined) { updates.push(`total = $${paramCount++}`); values.push(total); }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    values.push(id);
    const query = `UPDATE orders SET ${updates.join(', ')} WHERE id = $${paramCount} RETURNING *`;
    const result = await pool.query(query, values);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }
    res.json({ success: true, order: result.rows[0] });
  } catch (error) {
    console.error('Error updating order:', error);
    res.status(500).json({ error: error.message });
  }
});

// Delete order
app.delete('/orders/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('DELETE FROM orders WHERE id = $1 RETURNING id', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }
    res.json({ success: true, message: 'Order deleted' });
  } catch (error) {
    console.error('Error deleting order:', error);
    res.status(500).json({ error: error.message });
  }
});

// Add item to order
app.post('/orders/:id/items', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, price } = req.body;
    if (!name) {
      return res.status(400).json({ error: 'Item name is required' });
    }
    const result = await pool.query(`INSERT INTO order_items (order_id, item_name, price) VALUES ($1, $2, $3) RETURNING *`, [id, name, price || 0]);
    res.json({ success: true, item: result.rows[0] });
  } catch (error) {
    console.error('Error adding item:', error);
    res.status(500).json({ error: error.message });
  }
});

// Delete order item
app.delete('/order-items/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('DELETE FROM order_items WHERE id = $1 RETURNING id', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Item not found' });
    }
    res.json({ success: true, message: 'Item deleted' });
  } catch (error) {
    console.error('Error deleting item:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get all recipes
app.get('/api/recipes', async (req, res) => {
  try {
    const { search, tags } = req.query;
    
    let query = `
      SELECT *
      FROM meals
      WHERE meal_type = 'recipe'
    `;
    
    const params = [];
    let paramCount = 1;
    
    if (search) {
      query += ` AND (name ILIKE $${paramCount} OR ingredients ILIKE $${paramCount})`;
      params.push(`%${search}%`);
      paramCount++;
    }
    
    if (tags && tags.length > 0) {
      const tagArray = Array.isArray(tags) ? tags : [tags];
      query += ` AND tags && $${paramCount}::text[]`;
      params.push(tagArray);
      paramCount++;
    }
    
    query += ` ORDER BY name ASC`;
    
    const result = await pool.query(query, params);
    
    // Return just the array of recipes
    res.json(result.rows);
    
  } catch (error) {
    console.error('Error fetching recipes:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get single recipe
app.get('/api/recipes/:name', async (req, res) => {
  try {
    const { name } = req.params;
    
    const result = await pool.query(
      `SELECT * FROM meals WHERE name = $1 AND meal_type = 'recipe'`,
      [decodeURIComponent(name)]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Recipe not found' });
    }
    
    // Return just the recipe object (not wrapped in {success, recipe})
    res.json(result.rows[0]);
    
  } catch (error) {
    console.error('Error fetching recipe:', error);
    res.status(500).json({ error: error.message });
  }
});

// AI-powered tag suggestion
app.post('/suggest-tags', async (req, res) => {
  try {
    const { name, ingredients, directions, prep_time, cook_time } = req.body;
    if (!name) {
      return res.status(400).json({ error: 'Item name is required' });
    }

    const prompt = `Analyze this food item and suggest appropriate tags. Choose 4-8 tags that accurately describe it.

**Item Name:** ${name}
${ingredients ? `\n**Ingredients:**\n${ingredients.substring(0, 800)}` : ''}
${directions ? `\n**Directions:**\n${directions.substring(0, 800)}` : ''}
${prep_time ? `\n**Prep Time:** ${prep_time}` : ''}
${cook_time ? `\n**Cook Time:** ${cook_time}` : ''}

**Available Tags by Category:**
Meal Type: Breakfast, Lunch, Dinner, Brunch, Snack
Course: Appetizer, Main Dish, Side Dish, Salad, Soup, Dessert, Beverage, Sauce/Condiment
Dietary: Vegetarian, Vegan, Gluten-Free, Dairy-Free, Nut-Free, Low-Carb, Keto, Paleo
Cuisine: American, Italian, Mexican, Asian, Indian, Mediterranean, French, Thai, Korean, Japanese, Chinese, Greek, Middle Eastern
Cooking Method: Baked, Grilled, Fried, Slow Cooker, Instant Pot, One-Pot, No-Cook, Roasted, Sautéed, Steamed
Time: Quick (< 30 min), Medium (30-60 min), Long (> 60 min)
Difficulty: Easy, Medium, Hard
Characteristics: Healthy, Comfort Food, Kid-Friendly, Party Food, Make-Ahead, Meal Prep, Spicy, Sweet, Savory, Fresh, Hearty, Light

Return ONLY a JSON array. Example: ["Main Dish", "Mexican", "Medium (30-60 min)", "Medium", "Spicy"]`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 200,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error?.message || 'API request failed');
    }

    const text = data.content[0].text.trim();
    const tagsMatch = text.match(/\[.*\]/s);
    if (tagsMatch) {
      const tags = JSON.parse(tagsMatch[0]);
      res.json({ success: true, tags });
    } else {
      res.json({ success: true, tags: [] });
    }
  } catch (error) {
    console.error('Error suggesting tags:', error);
    res.status(500).json({ error: error.message, tags: [] });
  }
});

// Log a home cooked meal
app.post('/log-meal', async (req, res) => {
  try {
    const { recipeName } = req.body;
    if (!recipeName) {
      return res.status(400).json({ error: 'Recipe name is required' });
    }
    const result = await pool.query(
      `INSERT INTO orders (restaurant, logged_as_meal, meal_date, recipe_name) VALUES ($1, $2, $3, $4) RETURNING id`,
      [recipeName, true, new Date(), recipeName]
    );
    res.json({ success: true, message: 'Meal logged successfully!', orderId: result.rows[0].id });
  } catch (error) {
    console.error('Error logging meal:', error);
    res.status(500).json({ error: error.message });
  }
});

// Mark an existing order as a logged meal
app.post('/mark-as-meal/:orderId', async (req, res) => {
  try {
    const { orderId } = req.params;
    await pool.query(`UPDATE orders SET logged_as_meal = true, meal_date = $1 WHERE id = $2`, [new Date(), orderId]);
    res.json({ success: true, message: 'Order marked as logged meal!' });
  } catch (error) {
    console.error('Error marking as meal:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get meal history
app.get('/meal-history', async (req, res) => {
  try {
    const { search } = req.query;
    let query = `
      SELECT o.id, o.restaurant, o.recipe_name, o.meal_date, o.delivery_service, o.address, o.total,
             json_agg(json_build_object('id', oi.id, 'name', oi.item_name, 'price', oi.price, 'rating', oi.rating, 'assignedTo', oi.assigned_to, 'notes', oi.notes) ORDER BY oi.id) FILTER (WHERE oi.id IS NOT NULL) as items
      FROM orders o
      LEFT JOIN order_items oi ON o.id = oi.order_id
      WHERE o.logged_as_meal = true
    `;
    const params = [];
    if (search) {
      query += ` AND (o.restaurant ILIKE $1 OR o.recipe_name ILIKE $1)`;
      params.push(`%${search}%`);
    }
    query += ` GROUP BY o.id ORDER BY o.meal_date DESC`;
    const result = await pool.query(query, params);
    res.json({ meals: result.rows });
  } catch (error) {
    console.error('Error fetching meal history:', error);
    res.status(500).json({ error: error.message });
  }
});

// Delete a logged meal
app.delete('/meal-history/:mealId', async (req, res) => {
  try {
    const { mealId } = req.params;
    await pool.query('DELETE FROM orders WHERE id = $1 AND logged_as_meal = true', [mealId]);
    res.json({ success: true, message: 'Meal deleted from history' });
  } catch (error) {
    console.error('Error deleting meal:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get AI recommendation based on filters
app.get('/recommend', async (req, res) => {
  try {
    const { type, filters, random } = req.query;
    
    // Parse filters
    const filterArray = filters ? filters.split(',').filter(f => f) : [];
    
    if (type === 'cooking') {
      // Map filter IDs to actual tag names
      const filterToTagMap = {
        'breakfast': 'Breakfast',
        'lunch': 'Lunch',
        'dinner': 'Dinner',
        'side': 'Side Dish',
        'dessert': 'Dessert',
        'healthy': 'Healthy',
        'quick': 'Quick (< 30 min)',
        'filling': 'Hearty',
        'comfort': 'Comfort Food',
        'complex': 'Hard'
      };
      
      // Convert filter IDs to tag names, excluding "any" filters
      const tagFilters = filterArray
        .filter(f => !f.startsWith('any-'))
        .map(f => filterToTagMap[f] || f)
        .filter(Boolean);
      
      // Get recipes from database
      let query = `SELECT * FROM meals WHERE meal_type = 'recipe'`;
      const params = [];
      
      // Apply tag filters if any
      if (tagFilters.length > 0) {
        // Use && operator to check if recipe tags contain ANY of the selected filters
        query += ` AND tags && $1::text[]`;
        params.push(tagFilters);
      }
      
      query += ` ORDER BY RANDOM() LIMIT 1`;
      
      const result = await pool.query(query, params);
      
      if (result.rows.length === 0) {
        // If no exact match, try getting any recipe
        const anyRecipe = await pool.query(`SELECT * FROM meals WHERE meal_type = 'recipe' ORDER BY RANDOM() LIMIT 1`);
        
        if (anyRecipe.rows.length === 0) {
          return res.json({
            title: 'No Recipes Found',
            recommendation: '<p style="text-align: center; padding: 40px;">No recipes available in the database.</p>'
          });
        }
        
        // Return a random recipe with a note
        const recipe = anyRecipe.rows[0];
        let html = '<div style="text-align: center; padding: 20px; background: #FFF3CD; border: 2px solid #FFC107; border-radius: 8px; margin-bottom: 20px;">';
        html += '<p style="color: #856404; font-weight: 600;">No exact matches found for your filters, but here\'s a great recipe anyway!</p>';
        html += '</div>';
        
        html += buildRecipeHTML(recipe);
        
        return res.json({
          title: recipe.name,
          recommendation: html
        });
      }
      
      const recipe = result.rows[0];
      
      res.json({
        title: recipe.name,
        recommendation: buildRecipeHTML(recipe)
      });
      
    } else {
      // Takeout recommendations - Hybrid approach
      // 1. Get a past order that matches filters (if any)
      // 2. Use AI to suggest a new restaurant near Hazel Park, MI
      
      // Map filter IDs to characteristics
      const filterCharacteristics = {
        'cheap': 'affordable, budget-friendly',
        'healthy': 'healthy, fresh, nutritious',
        'filling': 'hearty portions, filling, satisfying',
        'fast': 'quick service, fast delivery',
        'comfort': 'comfort food, indulgent, classic'
      };
      
      const selectedCharacteristics = filterArray
        .filter(f => filterCharacteristics[f])
        .map(f => filterCharacteristics[f]);
      
      const vibeDescription = selectedCharacteristics.length > 0 
        ? selectedCharacteristics.join(', ')
        : 'any cuisine';
      
      try {
        // Get past orders from database
        let pastOrderQuery = `
          SELECT DISTINCT ON (restaurant) 
            restaurant, 
            address, 
            delivery_service,
            AVG(oi.rating) as avg_rating,
            COUNT(oi.id) as item_count
          FROM meals m
          LEFT JOIN meal_items oi ON m.id = oi.meal_id
          WHERE m.meal_type = 'takeout' 
            AND oi.rating >= 4
          GROUP BY restaurant, address, delivery_service
          ORDER BY restaurant, avg_rating DESC
          LIMIT 5
        `;
        
        const pastOrders = await pool.query(pastOrderQuery);
        const pastOrder = pastOrders.rows.length > 0 
          ? pastOrders.rows[Math.floor(Math.random() * pastOrders.rows.length)]
          : null;
        
        // Generate AI recommendation
        const aiPrompt = `You are a local food expert for the Hazel Park, Michigan area (within 15 miles). 

The user is looking for takeout with these vibes: ${vibeDescription}

Suggest ONE specific restaurant that:
1. Is within 15 miles of Hazel Park, MI
2. Matches the vibe: ${vibeDescription}
3. Is a real, existing restaurant
4. Has good reviews

Format your response as HTML with:
- Restaurant name as a heading
- Brief description (2-3 sentences)
- Type of cuisine
- Why it matches their vibe
- Approximate location (city/neighborhood)

Keep it friendly, casual, and enthusiastic. Use simple HTML tags only (h3, p, strong). No markdown.`;

        const aiResponse = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': process.env.ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01'
          },
          body: JSON.stringify({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 500,
            messages: [{
              role: 'user',
              content: aiPrompt
            }]
          })
        });
        
        const aiData = await aiResponse.json();
        const aiSuggestion = aiData.content[0].text;
        
        // Build recommendation HTML
        let html = '<div style="display: flex; flex-direction: column; gap: 24px;">';
        
        // Past order section (if exists)
        if (pastOrder) {
          html += `
            <div style="background: linear-gradient(135deg, #52c41a 0%, #3fa218 100%); 
                        padding: 20px; 
                        border-radius: 12px; 
                        border: 4px solid #4A4A1F;
                        color: white;">
              <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 12px;">
                <span style="font-size: 28px;">⭐</span>
                <h3 style="margin: 0; font-size: 18px; font-weight: 900; text-transform: uppercase;">
                  Order Again
                </h3>
              </div>
              <h2 style="margin: 0 0 8px 0; font-size: 24px; font-weight: 900;">
                ${pastOrder.restaurant}
              </h2>
              <p style="margin: 0 0 8px 0; font-size: 14px; opacity: 0.9;">
                ${pastOrder.address || 'Your past favorite!'}
              </p>
              <div style="display: flex; align-items: center; gap: 8px; font-size: 14px; font-weight: 600;">
                <span>⭐ ${pastOrder.avg_rating ? Number(pastOrder.avg_rating).toFixed(1) : '5.0'} average rating</span>
                <span>•</span>
                <span>${pastOrder.item_count} items ordered</span>
              </div>
            </div>
          `;
        }
        
        // AI suggestion section
        html += `
          <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); 
                      padding: 20px; 
                      border-radius: 12px; 
                      border: 4px solid #4A4A1F;
                      color: white;">
            <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 12px;">
              <span style="font-size: 28px;">✨</span>
              <h3 style="margin: 0; font-size: 18px; font-weight: 900; text-transform: uppercase;">
                Try Something New
              </h3>
            </div>
            <div style="line-height: 1.6;">
              ${aiSuggestion}
            </div>
          </div>
        `;
        
        html += '</div>';
        
        res.json({
          title: vibeDescription ? `${vibeDescription.split(',')[0].charAt(0).toUpperCase() + vibeDescription.split(',')[0].slice(1)} Takeout` : 'Order This!',
          recommendation: html
        });
        
      } catch (aiError) {
        console.error('AI recommendation error:', aiError);
        
        // Fallback to just past orders if AI fails
        let fallbackHtml = '<div style="text-align: center; padding: 40px;">';
        fallbackHtml += '<p style="font-size: 18px; color: #4A4A1F; margin-bottom: 20px;">Here are some of your favorites!</p>';
        fallbackHtml += '</div>';
        
        res.json({
          title: 'Order Again!',
          recommendation: fallbackHtml
        });
      }
    }
    
  } catch (error) {
    console.error('Error getting recommendation:', error);
    res.status(500).json({ error: error.message });
  }
});

// Helper function to build recipe HTML
function buildRecipeHTML(recipe) {
  let html = '<div class="rec-details">';
  
  // Info row
  html += '<div style="display: flex; gap: 16px; justify-content: center; margin-bottom: 12px; flex-wrap: wrap;">';
  html += `<div style="text-align: center; flex: 1; min-width: 80px;"><div style="font-size: 28px; margin-bottom: 4px;">⏱️</div><div style="font-weight: 600; color: #4A4A1F; font-size: 14px;">Prep: ${recipe.prep_time || 'N/A'}</div></div>`;
  html += `<div style="text-align: center; flex: 1; min-width: 80px;"><div style="font-size: 28px; margin-bottom: 4px;">🔥</div><div style="font-weight: 600; color: #4A4A1F; font-size: 14px;">Cook: ${recipe.cook_time || 'N/A'}</div></div>`;
  html += `<div style="text-align: center; flex: 1; min-width: 80px;"><div style="font-size: 28px; margin-bottom: 4px;">🍽️</div><div style="font-weight: 600; color: #4A4A1F; font-size: 14px;">Servings: ${recipe.servings || 'N/A'}</div></div>`;
  html += '</div>';
  
  // Tags
  if (recipe.tags && recipe.tags.length > 0) {
    html += '<div style="display: flex; justify-content: center; flex-wrap: wrap; gap: 8px; margin-bottom: 16px;">';
    recipe.tags.forEach(tag => {
      html += `<span class="tag">${tag}</span>`;
    });
    html += '</div>';
  }
  
  // Toggle buttons
  html += '<div class="recipe-toggles">';
  html += '<button class="recipe-toggle active" onclick="switchRecipeTab(\'ingredients\')">📝 Ingredients</button>';
  html += '<button class="recipe-toggle" onclick="switchRecipeTab(\'instructions\')">👩🏻‍🍳 Instructions</button>';
  html += '</div>';
  
  // Content box
  html += '<div class="recipe-content-box">';
  
  // Ingredients
  html += '<div id="ingredients-section" class="recipe-section active">';
  if (recipe.ingredients) {
    const ingredients = recipe.ingredients.split('\n').filter(i => i.trim());
    html += '<ul>';
    ingredients.forEach(ing => {
      html += `<li>${ing.trim()}</li>`;
    });
    html += '</ul>';
  } else {
    html += '<p>No ingredients listed.</p>';
  }
  html += '</div>';
  
  // Instructions
  html += '<div id="instructions-section" class="recipe-section">';
  if (recipe.directions) {
    html += `<p>${recipe.directions.replace(/\n/g, '<br><br>')}</p>`;
  } else {
    html += '<p>No instructions available.</p>';
  }
  html += '</div>';
  
  html += '</div>'; // Close recipe-content-box
  
  // Source button
  if (recipe.source_url) {
    html += `<div style="margin-top: 24px; text-align: center;"><a href="${recipe.source_url}" target="_blank" style="display: inline-block; padding: 12px 24px; background: #FF9800; color: white; text-decoration: none; font-weight: 800; border-radius: 8px; border: 4px solid #4A4A1F; transition: all 0.2s ease;">🌐 View Original Recipe</a></div>`;
  }
  
  html += '</div>';
  
  return html;
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`API Key configured: ${!!process.env.ANTHROPIC_API_KEY}`);
  console.log(`Database URL configured: ${!!process.env.DATABASE_URL}`);
  console.log(`\n🔧 To run database migration, visit: /run-migration\n`);
});
