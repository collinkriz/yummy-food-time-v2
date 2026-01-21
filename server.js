const express = require('express');
const multer = require('multer');
const cors = require('cors');
const { pool, initializeDatabase } = require('./database');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Initialize database on startup
initializeDatabase().catch(console.error);

// Extract order info endpoint
app.post('/extract-order', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No image uploaded' });
    }

    console.log('Image received:', req.file.mimetype, req.file.size, 'bytes');

    // Convert image to base64
    const base64Image = req.file.buffer.toString('base64');

    // Call Claude API
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
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: req.file.mimetype,
                  data: base64Image
                }
              },
              {
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
  "items": [
    {
      "name": "item name with customizations",
      "price": 0.00
    }
  ],
  "subtotal": 0.00,
  "deliveryFee": 0.00,
  "serviceFee": 0.00,
  "tax": 0.00,
  "discount": 0.00,
  "tip": 0.00,
  "total": 0.00
}

Look at EVERY section of the receipt carefully. The address is often near the top with the restaurant name, or in a delivery details section. Search thoroughly before saying "Not visible".`
              }
            ]
          }
        ]
      })
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('Claude API error:', data);
      return res.status(response.status).json({ 
        error: data.error?.message || 'Claude API error',
        details: data
      });
    }

    // Extract text from response
    const text = data.content
      .filter(item => item.type === 'text')
      .map(item => item.text)
      .join('\n')
      .trim();

    console.log('Claude response:', text);

    // Parse JSON (strip markdown if present)
    const cleanText = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const orderData = JSON.parse(cleanText);

    res.json({ success: true, data: orderData });

  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ 
      error: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// Save takeout order to database (using unified meals schema)
app.post('/orders', async (req, res) => {
  const client = await pool.connect();
  try {
    console.log('Received order data:', JSON.stringify(req.body, null, 2));
    
    const { restaurant, address, deliveryService, subtotal, deliveryFee, serviceFee, tax, discount, tip, total, items } = req.body;

    // Validate required fields
    if (!restaurant || !items || items.length === 0) {
      throw new Error('Restaurant and items are required');
    }

    await client.query('BEGIN');

    // Insert meal as type 'takeout'
    const mealResult = await client.query(
      `INSERT INTO meals (
        meal_type, name, restaurant, address, delivery_service, 
        subtotal, delivery_fee, service_fee, tax, discount, tip, total, meal_date
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      RETURNING id`,
      [
        'takeout',
        restaurant, // Use restaurant name as meal name for takeout
        restaurant, 
        address || 'Not provided', 
        deliveryService || 'Unknown', 
        subtotal || 0, 
        deliveryFee || 0, 
        serviceFee || 0, 
        tax || 0, 
        discount || 0, 
        tip || 0, 
        total || 0,
        new Date()
      ]
    );

    const mealId = mealResult.rows[0].id;

    // Insert items
    for (const item of items) {
      await client.query(
        `INSERT INTO meal_items (meal_id, item_name, price, assigned_to, rating, notes)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [mealId, item.name, item.price || 0, item.assignedTo || null, item.rating || 0, item.notes || null]
      );
    }

    await client.query('COMMIT');
    
    console.log('Takeout order saved successfully with ID:', mealId);

    res.json({ success: true, orderId: mealId });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error saving order:', error);
    res.status(500).json({ error: error.message, details: error.stack });
  } finally {
    client.release();
  }
});

// Get all takeout orders
app.get('/orders', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT m.*, 
             json_agg(
               json_build_object(
                 'id', mi.id,
                 'name', mi.item_name,
                 'price', mi.price,
                 'assignedTo', mi.assigned_to,
                 'rating', mi.rating,
                 'notes', mi.notes,
                 'tags', mi.tags
               ) ORDER BY mi.id
             ) FILTER (WHERE mi.id IS NOT NULL) as items
      FROM meals m
      LEFT JOIN meal_items mi ON m.id = mi.meal_id
      WHERE m.meal_type = 'takeout'
      GROUP BY m.id
      ORDER BY m.created_at DESC
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
      SELECT m.*, 
             json_agg(
               json_build_object(
                 'id', mi.id,
                 'name', mi.item_name,
                 'price', mi.price,
                 'assignedTo', mi.assigned_to,
                 'rating', mi.rating,
                 'notes', mi.notes,
                 'tags', mi.tags
               ) ORDER BY mi.id
             ) FILTER (WHERE mi.id IS NOT NULL) as items
      FROM meals m
      LEFT JOIN meal_items mi ON m.id = mi.meal_id
      WHERE m.id = $1 AND m.meal_type = 'takeout'
      GROUP BY m.id
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

// Update order item (rating, assignment, notes, tags)
app.patch('/order-items/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { rating, assignedTo, notes, tags } = req.body;

    const updates = [];
    const values = [];
    let paramCount = 1;

    if (rating !== undefined) {
      updates.push(`rating = $${paramCount++}`);
      values.push(rating);
    }
    if (assignedTo !== undefined) {
      updates.push(`assigned_to = $${paramCount++}`);
      values.push(assignedTo);
    }
    if (notes !== undefined) {
      updates.push(`notes = $${paramCount++}`);
      values.push(notes);
    }
    if (tags !== undefined) {
      updates.push(`tags = $${paramCount++}`);
      values.push(tags);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    values.push(id);
    const query = `UPDATE meal_items SET ${updates.join(', ')} WHERE id = $${paramCount} RETURNING *`;

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

// Update entire order (restaurant, address, delivery service, fees, etc.)
app.patch('/orders/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { restaurant, address, deliveryService, subtotal, deliveryFee, serviceFee, tax, discount, tip, total } = req.body;

    const updates = [];
    const values = [];
    let paramCount = 1;

    if (restaurant !== undefined) {
      updates.push(`name = $${paramCount}`, `restaurant = $${paramCount}`);
      values.push(restaurant);
      paramCount++;
    }
    if (address !== undefined) {
      updates.push(`address = $${paramCount++}`);
      values.push(address);
    }
    if (deliveryService !== undefined) {
      updates.push(`delivery_service = $${paramCount++}`);
      values.push(deliveryService);
    }
    if (subtotal !== undefined) {
      updates.push(`subtotal = $${paramCount++}`);
      values.push(subtotal);
    }
    if (deliveryFee !== undefined) {
      updates.push(`delivery_fee = $${paramCount++}`);
      values.push(deliveryFee);
    }
    if (serviceFee !== undefined) {
      updates.push(`service_fee = $${paramCount++}`);
      values.push(serviceFee);
    }
    if (tax !== undefined) {
      updates.push(`tax = $${paramCount++}`);
      values.push(tax);
    }
    if (discount !== undefined) {
      updates.push(`discount = $${paramCount++}`);
      values.push(discount);
    }
    if (tip !== undefined) {
      updates.push(`tip = $${paramCount++}`);
      values.push(tip);
    }
    if (total !== undefined) {
      updates.push(`total = $${paramCount++}`);
      values.push(total);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    updates.push(`updated_at = CURRENT_TIMESTAMP`);
    values.push(id);
    
    const query = `UPDATE meals SET ${updates.join(', ')} WHERE id = $${paramCount} AND meal_type = 'takeout' RETURNING *`;

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
    
    const result = await pool.query(
      'DELETE FROM meals WHERE id = $1 AND meal_type = \'takeout\' RETURNING id', 
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }

    res.json({ success: true, message: 'Order deleted' });

  } catch (error) {
    console.error('Error deleting order:', error);
    res.status(500).json({ error: error.message });
  }
});

// Add item to existing order
app.post('/orders/:id/items', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, price } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Item name is required' });
    }

    const result = await pool.query(
      `INSERT INTO meal_items (meal_id, item_name, price) 
       VALUES ($1, $2, $3) 
       RETURNING *`,
      [id, name, price || 0]
    );

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
    
    const result = await pool.query(
      'DELETE FROM meal_items WHERE id = $1 RETURNING id',
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Item not found' });
    }

    res.json({ success: true, message: 'Item deleted' });

  } catch (error) {
    console.error('Error deleting item:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== RECIPE ENDPOINTS ====================

// Get all recipes
app.get('/recipes', async (req, res) => {
  try {
    const { search, tags } = req.query;
    
    let query = `
      SELECT m.*
      FROM meals m
      WHERE m.meal_type = 'recipe'
    `;
    
    const params = [];
    let paramCount = 1;
    
    if (search) {
      query += ` AND (m.name ILIKE $${paramCount} OR m.ingredients ILIKE $${paramCount})`;
      params.push(`%${search}%`);
      paramCount++;
    }
    
    if (tags && tags.length > 0) {
      const tagArray = Array.isArray(tags) ? tags : [tags];
      query += ` AND m.tags && $${paramCount}::text[]`;
      params.push(tagArray);
      paramCount++;
    }
    
    query += ` ORDER BY m.name ASC`;
    
    const result = await pool.query(query, params);
    
    res.json({ success: true, recipes: result.rows });
    
  } catch (error) {
    console.error('Error fetching recipes:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get single recipe
app.get('/recipes/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      `SELECT * FROM meals WHERE id = $1 AND meal_type = 'recipe'`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Recipe not found' });
    }

    res.json({ success: true, recipe: result.rows[0] });

  } catch (error) {
    console.error('Error fetching recipe:', error);
    res.status(500).json({ error: error.message });
  }
});

// Update recipe tags
app.patch('/recipes/:id/tags', async (req, res) => {
  try {
    const { id } = req.params;
    const { tags } = req.body;

    const result = await pool.query(
      `UPDATE meals SET tags = $1, updated_at = CURRENT_TIMESTAMP 
       WHERE id = $2 AND meal_type = 'recipe' 
       RETURNING *`,
      [tags || [], id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Recipe not found' });
    }

    res.json({ success: true, recipe: result.rows[0] });

  } catch (error) {
    console.error('Error updating recipe tags:', error);
    res.status(500).json({ error: error.message });
  }
});

// Bulk tag recipes (for migration/batch tagging)
app.post('/recipes/bulk-tag', async (req, res) => {
  const client = await pool.connect();
  try {
    const { recipes } = req.body; // Array of { id, tags }
    
    if (!Array.isArray(recipes)) {
      return res.status(400).json({ error: 'recipes must be an array' });
    }

    await client.query('BEGIN');
    
    let updated = 0;
    for (const recipe of recipes) {
      if (recipe.id && recipe.tags) {
        await client.query(
          `UPDATE meals SET tags = $1, updated_at = CURRENT_TIMESTAMP 
           WHERE id = $2 AND meal_type = 'recipe'`,
          [recipe.tags, recipe.id]
        );
        updated++;
      }
    }
    
    await client.query('COMMIT');
    
    res.json({ success: true, updated });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error bulk tagging recipes:', error);
    res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});

// AI-powered tag suggestion endpoint
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

Carefully read all details. Return ONLY a JSON array of selected tags. Include at least one from: Course, Time, Difficulty.

Example: ["Main Dish", "Mexican", "Medium (30-60 min)", "Medium", "Spicy", "Comfort Food"]`;

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
        messages: [{
          role: 'user',
          content: prompt
        }]
      })
    });

    const data = await response.json();
    
    if (!response.ok) {
      throw new Error(data.error?.message || 'API request failed');
    }

    const text = data.content[0].text.trim();
    
    // Parse the JSON array from response
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
    const { recipeId, recipeName, rating, notes } = req.body;
    
    if (!recipeId && !recipeName) {
      return res.status(400).json({ error: 'Recipe ID or name is required' });
    }
    
    // If recipeId provided, just update the meal_date and rating
    if (recipeId) {
      const result = await pool.query(
        `UPDATE meals 
         SET meal_date = $1, overall_rating = $2, notes = $3, updated_at = CURRENT_TIMESTAMP
         WHERE id = $4 AND meal_type = 'recipe'
         RETURNING id`,
        [new Date(), rating || null, notes || null, recipeId]
      );
      
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Recipe not found' });
      }
      
      res.json({ 
        success: true, 
        message: 'Meal logged successfully!',
        mealId: result.rows[0].id 
      });
    } else {
      // Create a simple meal entry (for custom meals not from recipes)
      const result = await pool.query(
        `INSERT INTO meals (meal_type, name, meal_date, overall_rating, notes)
         VALUES ('recipe', $1, $2, $3, $4) 
         RETURNING id`,
        [recipeName, new Date(), rating || null, notes || null]
      );
      
      res.json({ 
        success: true, 
        message: 'Meal logged successfully!',
        mealId: result.rows[0].id 
      });
    }
    
  } catch (error) {
    console.error('Error logging meal:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get meal history (both takeout and home cooked)
app.get('/meal-history', async (req, res) => {
  try {
    const { search, mealType } = req.query;
    
    let query = `
      SELECT m.id, m.meal_type, m.name, m.restaurant, m.meal_date, m.delivery_service,
             m.address, m.total, m.overall_rating, m.tags,
             json_agg(
               json_build_object(
                 'id', mi.id,
                 'name', mi.item_name,
                 'price', mi.price,
                 'rating', mi.rating,
                 'assignedTo', mi.assigned_to,
                 'notes', mi.notes,
                 'tags', mi.tags
               ) ORDER BY mi.id
             ) FILTER (WHERE mi.id IS NOT NULL) as items
      FROM meals m
      LEFT JOIN meal_items mi ON m.id = mi.meal_id
      WHERE m.meal_date IS NOT NULL
    `;
    
    const params = [];
    let paramCount = 1;
    
    if (mealType) {
      query += ` AND m.meal_type = $${paramCount}`;
      params.push(mealType);
      paramCount++;
    }
    
    if (search) {
      query += ` AND (m.name ILIKE $${paramCount} OR m.restaurant ILIKE $${paramCount})`;
      params.push(`%${search}%`);
      paramCount++;
    }
    
    query += ` GROUP BY m.id ORDER BY m.meal_date DESC`;
    
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
    
    // Just clear the meal_date to "unlog" it, don't delete the meal
    await pool.query(
      'UPDATE meals SET meal_date = NULL, overall_rating = NULL WHERE id = $1',
      [mealId]
    );
    
    res.json({ success: true, message: 'Meal removed from history' });
    
  } catch (error) {
    console.error('Error removing meal from history:', error);
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`API Key configured: ${!!process.env.ANTHROPIC_API_KEY}`);
  console.log(`Database URL configured: ${!!process.env.DATABASE_URL}`);
});
