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

// Save order to database
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

    // Insert order (use 0 as default for missing numeric values)
    const orderResult = await client.query(
      `INSERT INTO orders (restaurant, address, delivery_service, subtotal, delivery_fee, service_fee, tax, discount, tip, total)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id`,
      [
        restaurant, 
        address || 'Not provided', 
        deliveryService || 'Unknown', 
        subtotal || 0, 
        deliveryFee || 0, 
        serviceFee || 0, 
        tax || 0, 
        discount || 0, 
        tip || 0, 
        total || 0
      ]
    );

    const orderId = orderResult.rows[0].id;

    // Insert items
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
      SELECT o.*, 
             json_agg(
               json_build_object(
                 'id', oi.id,
                 'name', oi.item_name,
                 'price', oi.price,
                 'assignedTo', oi.assigned_to,
                 'rating', oi.rating,
                 'notes', oi.notes
               ) ORDER BY oi.id
             ) as items
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
      SELECT o.*, 
             json_agg(
               json_build_object(
                 'id', oi.id,
                 'name', oi.item_name,
                 'price', oi.price,
                 'assignedTo', oi.assigned_to,
                 'rating', oi.rating,
                 'notes', oi.notes
               ) ORDER BY oi.id
             ) as items
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

// Update order item (rating, assignment, notes)
app.patch('/order-items/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, price, assigned_to, rating, notes, tags } = req.body;

    const result = await pool.query(
      `UPDATE order_items 
       SET item_name = COALESCE($1, item_name),
           price = COALESCE($2, price),
           assigned_to = COALESCE($3, assigned_to),
           rating = COALESCE($4, rating),
           notes = COALESCE($5, notes),
           tags = COALESCE($6, tags)
       WHERE id = $7
       RETURNING *`,
      [name, price, assigned_to, rating, notes, tags, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Item not found' });
    }

    res.json({ success: true, item: result.rows[0] });

  } catch (error) {
    console.error('Error updating item:', error);
    res.status(500).json({ error: error.message });
  }
});

// Delete individual order item
app.delete('/order-items/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      'DELETE FROM order_items WHERE id = $1 RETURNING *',
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Item not found' });
    }

    res.json({ success: true, message: 'Item deleted successfully' });

  } catch (error) {
    console.error('Error deleting item:', error);
    res.status(500).json({ error: error.message });
  }
});

// Update entire order
app.put('/orders/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const { restaurant, address, deliveryService, subtotal, deliveryFee, serviceFee, tax, discount, tip, total, items } = req.body;

    console.log('Updating order:', id, JSON.stringify(req.body, null, 2));

    // Validate required fields
    if (!restaurant || !items || items.length === 0) {
      throw new Error('Restaurant and items are required');
    }

    await client.query('BEGIN');

    // Update order
    await client.query(
      `UPDATE orders 
       SET restaurant = $1, address = $2, delivery_service = $3, 
           subtotal = $4, delivery_fee = $5, service_fee = $6, 
           tax = $7, discount = $8, tip = $9, total = $10
       WHERE id = $11`,
      [
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
        id
      ]
    );

    // Delete existing items
    await client.query('DELETE FROM order_items WHERE order_id = $1', [id]);

    // Insert updated items
    for (const item of items) {
      await client.query(
        `INSERT INTO order_items (order_id, item_name, price, assigned_to, rating, notes)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [id, item.name, item.price || 0, item.assignedTo || null, item.rating || 0, item.notes || null]
      );
    }

    await client.query('COMMIT');

    console.log('Order updated successfully:', id);

    res.json({ success: true, orderId: id });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error updating order:', error);
    res.status(500).json({ error: error.message, details: error.stack });
  } finally {
    client.release();
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

// Chat endpoint for food recommendations
app.post('/chat', async (req, res) => {
  try {
    const { message, history } = req.body;

    if (!message) {
      return res.status(400).json({ error: 'Message is required' });
    }

    // Get user's order history for context
    const ordersResult = await pool.query(`
      SELECT o.restaurant, o.delivery_service, o.total, o.created_at,
             json_agg(
               json_build_object(
                 'name', oi.item_name,
                 'price', oi.price,
                 'assignedTo', oi.assigned_to,
                 'rating', oi.rating,
                 'notes', oi.notes
               ) ORDER BY oi.rating DESC NULLS LAST
             ) as items
      FROM orders o
      LEFT JOIN order_items oi ON o.id = oi.order_id
      GROUP BY o.id
      ORDER BY o.created_at DESC
      LIMIT 20
    `);

    // Load recipe library from Paprika export
    const fs = require('fs');
    const path = require('path');
    const recipesPath = path.join(__dirname, 'recipes.json');
    let recipeContext = '';
    
    if (fs.existsSync(recipesPath)) {
      const recipes = JSON.parse(fs.readFileSync(recipesPath, 'utf8'));
      recipeContext = `\n\nUser's Home Recipe Library (${recipes.length} recipes from Paprika):\n`;
      recipeContext += 'You have access to full recipe details including ingredients and directions. When user asks about cooking at home, recommend from these recipes.\n\n';
      
      // For efficiency, just list recipe names in the main prompt
      // Full details will be provided when specifically asked
      const recipeList = recipes.map((r, i) => {
        let info = `${i + 1}. ${r.name}`;
        if (r.prep_time || r.cook_time) {
          const times = [];
          if (r.prep_time) times.push(`${r.prep_time}`);
          if (r.cook_time) times.push(`${r.cook_time}`);
          info += ` (${times.join(' + ')})`;
        }
        return info;
      }).join('\n');
      
      recipeContext += recipeList;
      recipeContext += '\n\nIMPORTANT: ';
      recipeContext += '- When user asks about cooking, recommend specific recipes from this list by name\n';
      recipeContext += '- If user asks for ingredients or directions for a recipe, provide the full details\n';
      recipeContext += '- You have access to complete ingredients lists and step-by-step directions for all recipes\n';
      recipeContext += '- Never say you don\'t have access to recipes or their details\n';
      
      // Store full recipes in a global for easy access
      global.recipeLibrary = recipes;
    }

    // Build context from order history
    let orderContext = '';
    if (ordersResult.rows.length > 0) {
      orderContext = '\n\nUser\'s Recent Takeout Order History:\n';
      ordersResult.rows.forEach((order, i) => {
        orderContext += `\n${i + 1}. ${order.restaurant}`;
        if (order.delivery_service && order.delivery_service !== 'Unknown') {
          orderContext += ` (via ${order.delivery_service})`;
        }
        orderContext += `\n   Items ordered:\n`;
        order.items.forEach(item => {
          orderContext += `   - ${item.name} ($${parseFloat(item.price).toFixed(2)})`;
          if (item.rating > 0) {
            orderContext += ` - Rated: ${item.rating}/5 stars`;
          }
          if (item.notes) {
            orderContext += ` - Notes: "${item.notes}"`;
          }
          orderContext += '\n';
        });
      });
    } else {
      orderContext = '\n\nThe user has no takeout order history yet.';
    }

    // Check if user is asking for specific recipe details
    let recipeDetails = '';
    const lowerMessage = message.toLowerCase();
    
    // Keywords that indicate they want recipe details
    if ((lowerMessage.includes('ingredient') || lowerMessage.includes('direction') || 
         lowerMessage.includes('how to make') || lowerMessage.includes('how do i make') ||
         lowerMessage.includes('recipe for') || lowerMessage.includes('steps')) && 
        global.recipeLibrary) {
      
      // Try to find matching recipe
      const matchedRecipe = global.recipeLibrary.find(r => 
        lowerMessage.includes(r.name.toLowerCase())
      );
      
      if (matchedRecipe) {
        recipeDetails = `\n\nFULL RECIPE DETAILS FOR: ${matchedRecipe.name}\n`;
        recipeDetails += `\nINGREDIENTS:\n${matchedRecipe.ingredients}\n`;
        recipeDetails += `\nDIRECTIONS:\n${matchedRecipe.directions}\n`;
        if (matchedRecipe.notes) {
          recipeDetails += `\nNOTES:\n${matchedRecipe.notes}\n`;
        }
      }
    }

    // Build conversation messages
    const messages = [
      {
        role: 'user',
        content: `You're a helpful food recommendation assistant. Be conversational but professional - like a useful app, not a casual friend. Keep responses brief (1-2 short paragraphs maximum, ideally 2-4 sentences).

${recipeContext}

${orderContext}

${recipeDetails}

Guidelines:
- Professional but friendly tone
- Brief and direct responses
- For COOKING AT HOME questions: recommend specific recipes from the recipe library above by name
- For TAKEOUT questions: reference their order history  
- When user asks for ingredients or directions, provide the full details from the recipe data above
- Ask follow-up questions when helpful
- Use complete sentences, proper grammar

Examples of good responses:
"For a healthy main dish, I'd recommend the Avocado Lime Salmon or Baked Sesame-Ginger Salmon in Parchment from your recipe library. Both are quick to prepare and packed with flavor."

"Based on your 5-star rating for the Hot Honey Chicken, I'd recommend trying the Nashville Hot sandwich at the new spot on John R."

"Looking at your recipes, the Chili Garlic Noodles with Crispy Tofu would be perfect - it's bold, flavorful, and comes together quickly."

Keep responses focused and concise.`
      }
    ];

    // Add conversation history
    if (history && history.length > 0) {
      messages.push(...history);
    }

    // Add current message
    messages.push({ role: 'user', content: message });

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
        messages: messages
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

    res.json({ success: true, response: text });

  } catch (error) {
    console.error('Error in chat:', error);
    res.status(500).json({ error: error.message });
  }
});

// Recommendation endpoint
app.get('/recommend', async (req, res) => {
  try {
    const { type, filters, random } = req.query;
    const filterList = filters ? filters.split(',').filter(f => f) : [];
    const isRandom = random === 'true';
    
    if (type === 'takeout') {
      // Get orders from database with filter matching
      const ordersResult = await pool.query(`
        SELECT o.restaurant, o.address, o.delivery_service,
               json_agg(
                 json_build_object(
                   'name', oi.item_name,
                   'price', oi.price,
                   'rating', oi.rating,
                   'assignedTo', oi.assigned_to
                 ) ORDER BY oi.rating DESC NULLS LAST
               ) as items
        FROM orders o
        LEFT JOIN order_items oi ON o.id = oi.order_id
        GROUP BY o.restaurant, o.address, o.delivery_service
        ORDER BY RANDOM()
        LIMIT 50
      `);
      
      if (ordersResult.rows.length === 0) {
        return res.status(404).json({ error: 'No order history found. Upload some orders first!' });
      }
      
      // Simple filter logic for takeout
      let candidates = ordersResult.rows;
      
      if (filterList.includes('cheap')) {
        // Filter for restaurants with average order < $30
        candidates = candidates.filter(o => {
          const avgPrice = o.items.reduce((sum, item) => sum + parseFloat(item.price || 0), 0) / o.items.length;
          return avgPrice < 15;
        });
      }
      
      if (filterList.includes('healthy')) {
        // Look for salad, bowl, veggie keywords
        candidates = candidates.filter(o => 
          o.restaurant.toLowerCase().includes('salad') ||
          o.restaurant.toLowerCase().includes('bowl') ||
          o.items.some(item => 
            item.name.toLowerCase().includes('salad') ||
            item.name.toLowerCase().includes('veggie') ||
            item.name.toLowerCase().includes('healthy')
          )
        );
      }
      
      // If no matches after filtering, use all
      if (candidates.length === 0) {
        candidates = ordersResult.rows;
      }
      
      // Pick random from candidates
      const selected = candidates[Math.floor(Math.random() * candidates.length)];
      const topItems = selected.items.filter(item => (item.rating || 0) >= 4).slice(0, 3);
      
      let recommendation = `<div class="rec-details">`;
      recommendation += `<h3 style="font-size: 24px; font-weight: 900; color: #4A4A1F; margin-bottom: 12px;">${selected.restaurant}</h3>`;
      if (selected.address) {
        recommendation += `<p style="color: #666; margin-bottom: 16px;">📍 ${selected.address}</p>`;
      }
      
      if (topItems.length > 0) {
        recommendation += `<p style="font-weight: 700; margin-bottom: 10px;">Try these:</p><ul style="margin-left: 20px;">`;
        topItems.forEach(item => {
          recommendation += `<li style="margin-bottom: 8px;"><strong>${item.name}</strong>`;
          if (item.rating === 5) recommendation += ` ⭐⭐⭐⭐⭐`;
          else if (item.rating === 4) recommendation += ` ⭐⭐⭐⭐`;
          recommendation += `</li>`;
        });
        recommendation += `</ul>`;
      }
      recommendation += `</div>`;
      
      return res.json({
        success: true,
        title: selected.restaurant,
        recommendation: recommendation
      });
      
    } else if (type === 'cooking') {
      // Load recipes from JSON file
      const fs = require('fs');
      const path = require('path');
      const recipesPath = path.join(__dirname, 'recipes.json');
      
      if (!fs.existsSync(recipesPath)) {
        return res.status(404).json({ error: 'No recipes found. Please upload your recipe collection.' });
      }
      
      const recipes = JSON.parse(fs.readFileSync(recipesPath, 'utf8'));
      
      // Filter logic for cooking
      let candidates = recipes;
      
      // Style filters
      if (filterList.includes('quick')) {
        candidates = candidates.filter(r => 
          (r.prep_time && r.prep_time.includes('min') && parseInt(r.prep_time) <= 30) ||
          (r.cook_time && r.cook_time.includes('min') && parseInt(r.cook_time) <= 30) ||
          r.name.toLowerCase().includes('quick') ||
          r.name.toLowerCase().includes('easy')
        );
      }
      
      if (filterList.includes('healthy')) {
        candidates = candidates.filter(r =>
          r.name.toLowerCase().includes('salad') ||
          r.name.toLowerCase().includes('veggie') ||
          r.name.toLowerCase().includes('healthy') ||
          r.name.toLowerCase().includes('salmon') ||
          r.name.toLowerCase().includes('tofu')
        );
      }
      
      if (filterList.includes('complex')) {
        candidates = candidates.filter(r =>
          r.difficulty.toLowerCase().includes('hard') ||
          r.difficulty.toLowerCase().includes('complex') ||
          (r.cook_time && parseInt(r.cook_time) > 60)
        );
      }
      
      if (filterList.includes('comfort')) {
        candidates = candidates.filter(r =>
          r.name.toLowerCase().includes('mac') ||
          r.name.toLowerCase().includes('cheese') ||
          r.name.toLowerCase().includes('pasta') ||
          r.name.toLowerCase().includes('bread') ||
          r.name.toLowerCase().includes('pizza')
        );
      }
      
      if (filterList.includes('filling')) {
        candidates = candidates.filter(r =>
          r.name.toLowerCase().includes('pasta') ||
          r.name.toLowerCase().includes('rice') ||
          r.name.toLowerCase().includes('burrito') ||
          r.name.toLowerCase().includes('bowl') ||
          r.name.toLowerCase().includes('stew')
        );
      }
      
      // AI Category filters
      if (filterList.includes('main')) {
        candidates = candidates.filter(r => 
          r.ai_category && r.ai_category.includes('Main Dish')
        );
      }
      
      if (filterList.includes('salad')) {
        candidates = candidates.filter(r => 
          r.ai_category && r.ai_category.includes('Salad')
        );
      }
      
      if (filterList.includes('soup')) {
        candidates = candidates.filter(r => 
          r.ai_category && r.ai_category.includes('Soup')
        );
      }
      
      if (filterList.includes('breakfast')) {
        candidates = candidates.filter(r => 
          r.ai_category && r.ai_category.includes('Breakfast')
        );
      }
      
      if (filterList.includes('dessert')) {
        candidates = candidates.filter(r => 
          r.ai_category && r.ai_category.includes('Dessert')
        );
      }
      
      if (filterList.includes('side')) {
        candidates = candidates.filter(r => 
          r.ai_category && r.ai_category.includes('Side Dish')
        );
      }
      
      if (filterList.includes('sauce')) {
        candidates = candidates.filter(r => 
          r.ai_category && r.ai_category.includes('Sauce')
        );
      }
      
      if (filterList.includes('appetizer')) {
        candidates = candidates.filter(r => 
          r.ai_category && r.ai_category.includes('Appetizer')
        );
      }
      
      // If no matches, use all
      if (candidates.length === 0) {
        candidates = recipes;
      }
      
      // Pick random
      const selected = candidates[Math.floor(Math.random() * candidates.length)];
      
      // Build info header - always show all three fields
      let recommendation = `<div class="rec-info-header">`;
      recommendation += `<div class="rec-info-item"><span>⏱️</span> Prep: ${selected.prep_time || 'N/A'}</div>`;
      recommendation += `<div class="rec-info-item"><span>🔥</span> Cook: ${selected.cook_time || 'N/A'}</div>`;
      recommendation += `<div class="rec-info-item"><span>🍽️</span> Servings: ${selected.servings || 'N/A'}</div>`;
      recommendation += `</div>`;
      
      // Toggle buttons (separate from content box)
      recommendation += `
        <div class="recipe-toggles">
          <button class="recipe-toggle active" onclick="switchRecipeTab('ingredients')">📝 Ingredients</button>
          <button class="recipe-toggle" onclick="switchRecipeTab('instructions')">👩🏻‍🍳 Instructions</button>
        </div>
      `;
      
      // Content box with sections
      recommendation += `<div class="recipe-content-box">`;
      
      // Ingredients section
      recommendation += `<div class="recipe-section active" id="ingredients-section">`;
      if (selected.ingredients) {
        // Format ingredients as list
        const ingredientLines = selected.ingredients.split('\n').filter(line => line.trim());
        recommendation += `<ul>`;
        ingredientLines.forEach(line => {
          if (line.trim()) {
            recommendation += `<li>${line.trim()}</li>`;
          }
        });
        recommendation += `</ul>`;
      } else {
        recommendation += `<p>No ingredients listed.</p>`;
      }
      recommendation += `</div>`;
      
      // Instructions section
      recommendation += `<div class="recipe-section" id="instructions-section">`;
      if (selected.directions) {
        // Format directions as paragraphs
        const directionLines = selected.directions.split('\n\n');
        directionLines.forEach((para, i) => {
          if (para.trim()) {
            recommendation += `<p><strong>Step ${i + 1}:</strong> ${para.trim()}</p>`;
          }
        });
      } else {
        recommendation += `<p>No instructions available.</p>`;
      }
      
      // Add notes if available
      if (selected.notes && selected.notes.trim()) {
        recommendation += `<div style="margin-top: 20px; padding: 16px; background: linear-gradient(135deg, #FFF9E6 0%, #FFE082 100%); border: 3px solid #FF9800;">`;
        recommendation += `<h4>📌 Notes:</h4>`;
        recommendation += `<p>${selected.notes}</p>`;
        recommendation += `</div>`;
      }
      
      recommendation += `</div>`; // Close instructions section
      
      recommendation += `</div>`; // Close recipe-content-box
      
      return res.json({
        success: true,
        title: selected.name,
        recommendation: recommendation
      });
    }
    
    return res.status(400).json({ error: 'Invalid type. Must be "takeout" or "cooking"' });
    
  } catch (error) {
    console.error('Recommendation error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Dice roll - random restaurant recommendation
app.get('/dice-roll', async (req, res) => {
  try {
    // Get all restaurants with their top-rated items
    const ordersResult = await pool.query(`
      SELECT DISTINCT ON (o.restaurant) 
             o.restaurant, 
             o.address,
             o.delivery_service,
             json_agg(
               json_build_object(
                 'name', oi.item_name,
                 'rating', oi.rating,
                 'assignedTo', oi.assigned_to
               ) ORDER BY oi.rating DESC NULLS LAST
             ) FILTER (WHERE oi.rating >= 4) as top_items
      FROM orders o
      LEFT JOIN order_items oi ON o.id = oi.order_id
      GROUP BY o.restaurant, o.address, o.delivery_service
      ORDER BY o.restaurant, RANDOM()
    `);
    
    if (ordersResult.rows.length === 0) {
      return res.status(404).json({ 
        error: 'No order history found. Upload some orders first!' 
      });
    }
    
    // Pick a random restaurant
    const randomRestaurant = ordersResult.rows[Math.floor(Math.random() * ordersResult.rows.length)];
    
    // Build recommendation text
    let recommendation = '';
    
    if (randomRestaurant.top_items && randomRestaurant.top_items.length > 0) {
      const topItems = randomRestaurant.top_items.filter(item => item.rating >= 4);
      
      if (topItems.length > 0) {
        const collinItems = topItems.filter(item => item.assignedTo === 'Collin');
        const emilyItems = topItems.filter(item => item.assignedTo === 'Emily');
        
        recommendation = '<div style="margin-bottom: 12px;">';
        
        if (collinItems.length > 0) {
          recommendation += `<strong>For Collin:</strong> ${collinItems[0].name}`;
          if (collinItems[0].rating === 5) recommendation += ' ⭐⭐⭐⭐⭐';
          recommendation += '<br>';
        }
        
        if (emilyItems.length > 0) {
          recommendation += `<strong>For Emily:</strong> ${emilyItems[0].name}`;
          if (emilyItems[0].rating === 5) recommendation += ' ⭐⭐⭐⭐⭐';
        }
        
        if (collinItems.length === 0 && emilyItems.length === 0) {
          // If no specific assignments, just show top items
          recommendation += `Try: ${topItems[0].name}`;
          if (topItems[0].rating === 5) recommendation += ' ⭐⭐⭐⭐⭐';
          if (topItems.length > 1) {
            recommendation += ` or ${topItems[1].name}`;
            if (topItems[1].rating === 5) recommendation += ' ⭐⭐⭐⭐⭐';
          }
        }
        
        recommendation += '</div>';
      } else {
        recommendation = '<div>You\'ve ordered from here before. Try something new!</div>';
      }
    } else {
      recommendation = '<div>Give this place another try!</div>';
    }
    
    res.json({
      success: true,
      restaurant: randomRestaurant.restaurant,
      address: randomRestaurant.address,
      deliveryService: randomRestaurant.delivery_service,
      recommendation: recommendation
    });
    
  } catch (error) {
    console.error('Error in dice roll:', error);
    res.status(500).json({ error: error.message });
  }
});

// Chat greeting endpoint
app.get('/chat-greeting', async (req, res) => {
  try {
    const hour = new Date().getHours();
    
    // Get recent orders for context
    const ordersResult = await pool.query(`
      SELECT o.restaurant, o.created_at,
             json_agg(
               json_build_object(
                 'name', oi.item_name,
                 'rating', oi.rating
               ) ORDER BY oi.rating DESC NULLS LAST
             ) FILTER (WHERE oi.rating >= 4) as top_items
      FROM orders o
      LEFT JOIN order_items oi ON o.id = oi.order_id
      GROUP BY o.id
      ORDER BY o.created_at DESC
      LIMIT 5
    `);
    
    let greeting = '';
    
    // Time-based greetings
    if (hour >= 5 && hour < 11) {
      greeting = "Good morning! What can I help you find for breakfast?";
    } else if (hour >= 11 && hour < 14) {
      greeting = "It's lunch time. What are you in the mood for?";
    } else if (hour >= 14 && hour < 17) {
      greeting = "Looking for a snack or early dinner?";
    } else if (hour >= 17 && hour < 21) {
      greeting = "What sounds good for dinner?";
    } else {
      greeting = "What can I help you order tonight?";
    }
    
    // Add context if they have recent orders
    if (ordersResult.rows.length > 0) {
      const recentRestaurant = ordersResult.rows[0].restaurant;
      const daysSinceOrder = Math.floor((Date.now() - new Date(ordersResult.rows[0].created_at)) / (1000 * 60 * 60 * 24));
      
      if (daysSinceOrder === 0) {
        const greetings = [
          `You've already ordered today. Looking for something else?`,
          `Ready to order again? What sounds good?`,
          `What can I help you find?`
        ];
        greeting = greetings[Math.floor(Math.random() * greetings.length)];
      } else if (daysSinceOrder < 3) {
        // Don't suggest same restaurant
        greeting = greeting.replace('What sounds good?', `Any preferences?`);
      }
    }
    
    res.json({ success: true, greeting });
    
  } catch (error) {
    console.error('Error generating greeting:', error);
    res.json({ success: true, greeting: "Hey! What sounds good?" });
  }
});

// Health check
app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ 
      status: 'ok', 
      hasApiKey: !!process.env.ANTHROPIC_API_KEY,
      database: 'connected'
    });
  } catch (error) {
    res.status(500).json({ 
      status: 'error', 
      hasApiKey: !!process.env.ANTHROPIC_API_KEY,
      database: 'disconnected',
      error: error.message
    });
  }
});

// Get all recipes endpoint
app.get('/api/recipes', (req, res) => {
  try {
    const fs = require('fs');
    const path = require('path');
    const recipesPath = path.join(__dirname, 'recipes.json');
    
    if (!fs.existsSync(recipesPath)) {
      return res.status(404).json({ error: 'Recipes file not found' });
    }
    
    const recipes = JSON.parse(fs.readFileSync(recipesPath, 'utf8'));
    res.json(recipes);
  } catch (error) {
    console.error('Error loading recipes:', error);
    res.status(500).json({ error: 'Failed to load recipes' });
  }
});

// ONE-TIME: Add tags column to existing database
app.get('/admin/migrate-add-tags-column', async (req, res) => {
  try {
    // Check if column already exists
    const checkColumn = await pool.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name='order_items' AND column_name='tags'
    `);
    
    if (checkColumn.rows.length > 0) {
      return res.send('✅ Tags column already exists! No migration needed.');
    }
    
    // Add the tags column
    await pool.query(`
      ALTER TABLE order_items 
      ADD COLUMN tags TEXT[]
    `);
    
    res.send('✅ Successfully added tags column to order_items table!');
    
  } catch (error) {
    console.error('Migration error:', error);
    res.status(500).send(`❌ Error: ${error.message}`);
  }
});

// ONE-TIME: Batch tag all recipes (run once after deployment)
app.get('/admin/tag-all-recipes', async (req, res) => {
  try {
    const fs = require('fs');
    const path = require('path');
    const recipesPath = path.join(__dirname, 'recipes.json');
    
    const recipes = JSON.parse(fs.readFileSync(recipesPath, 'utf8'));
    const taggedRecipes = [];
    let successCount = 0;
    let errorCount = 0;
    
    // Send initial response so connection doesn't timeout
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.write(`Starting to tag ${recipes.length} recipes...\n\n`);
    
    for (let i = 0; i < recipes.length; i++) {
      const recipe = recipes[i];
      
      res.write(`[${i + 1}/${recipes.length}] Tagging: ${recipe.name}... `);
      
      try {
        const prompt = `Analyze this recipe and assign appropriate tags. Choose tags that accurately describe this recipe based on reading the full content.

**Recipe Name:** ${recipe.name}
**Ingredients:** ${(recipe.ingredients || '').substring(0, 800)}
**Directions:** ${(recipe.directions || '').substring(0, 800)}
**Prep Time:** ${recipe.prep_time || 'N/A'}
**Cook Time:** ${recipe.cook_time || 'N/A'}

**Available Tags by Category:**
Meal Type: Breakfast, Lunch, Dinner, Brunch, Snack
Course: Appetizer, Main Dish, Side Dish, Salad, Soup, Dessert, Beverage, Sauce/Condiment
Dietary: Vegetarian, Vegan, Gluten-Free, Dairy-Free, Nut-Free, Low-Carb, Keto, Paleo
Cuisine: American, Italian, Mexican, Asian, Indian, Mediterranean, French, Thai, Korean, Japanese, Chinese, Greek, Middle Eastern
Cooking Method: Baked, Grilled, Fried, Slow Cooker, Instant Pot, One-Pot, No-Cook, Roasted, Sautéed, Steamed
Time: Quick (< 30 min), Medium (30-60 min), Long (> 60 min)
Difficulty: Easy, Medium, Hard
Characteristics: Healthy, Comfort Food, Kid-Friendly, Party Food, Make-Ahead, Meal Prep, Spicy, Sweet, Savory, Fresh, Hearty, Light

Return ONLY a JSON array of 4-8 selected tags. Example: ["Main Dish", "Italian", "Medium (30-60 min)", "Medium", "Comfort Food"]`;

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
        const text = data.content[0].text.trim();
        const tagsMatch = text.match(/\[.*\]/s);
        
        if (tagsMatch) {
          recipe.tags = JSON.parse(tagsMatch[0]);
          successCount++;
          res.write(`✅ ${recipe.tags.length} tags\n`);
        } else {
          recipe.tags = recipe.ai_category || [];
          errorCount++;
          res.write(`⚠️ fallback\n`);
        }
        
      } catch (error) {
        recipe.tags = recipe.ai_category || [];
        errorCount++;
        res.write(`❌ error\n`);
      }
      
      taggedRecipes.push(recipe);
      
      // Small delay to avoid rate limits
      await new Promise(resolve => setTimeout(resolve, 600));
    }
    
    // Save tagged recipes
    fs.writeFileSync(recipesPath, JSON.stringify(taggedRecipes, null, 2));
    
    res.write(`\n✅ Complete! ${successCount} success, ${errorCount} errors\n`);
    res.write(`Updated recipes.json with tags.\n`);
    res.end();
    
  } catch (error) {
    console.error('Tagging error:', error);
    res.status(500).json({ error: error.message });
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`API Key configured: ${!!process.env.ANTHROPIC_API_KEY}`);
  console.log(`Database URL configured: ${!!process.env.DATABASE_URL}`);
});
