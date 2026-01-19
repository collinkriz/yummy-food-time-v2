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
                text: `Extract the following information from this food delivery order receipt (DoorDash, Uber Eats, Grubhub, etc.) and respond ONLY with a JSON object (no markdown, no backticks, no preamble):

{
  "restaurant": "restaurant name",
  "address": "restaurant address or 'Not visible' if not shown",
  "deliveryService": "name of delivery service (DoorDash, Uber Eats, Grubhub, etc.) or 'Unknown'",
  "items": [
    {
      "name": "item name with any customizations",
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

Be precise and extract all visible fields. If a field is not visible, use 0.00 for numbers or "Not visible" for text.`
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
    const { assignedTo, rating, notes } = req.body;

    const result = await pool.query(
      `UPDATE order_items 
       SET assigned_to = COALESCE($1, assigned_to),
           rating = COALESCE($2, rating),
           notes = COALESCE($3, notes)
       WHERE id = $4
       RETURNING *`,
      [assignedTo, rating, notes, id]
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

    // Build context from order history
    let orderContext = '';
    if (ordersResult.rows.length > 0) {
      orderContext = '\n\nUser\'s recent order history:\n';
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
      orderContext = '\n\nThe user has no order history yet.';
    }

    // Build conversation messages
    const messages = [
      {
        role: 'user',
        content: `You are a helpful food recommendation assistant. Your job is to help users decide what to order for their next meal based on their preferences, past orders, and cravings.

${orderContext}

When making recommendations:
- Consider their past orders and ratings
- Ask clarifying questions if needed (cuisine type, dietary restrictions, budget, etc.)
- Be enthusiastic and descriptive about food
- Suggest specific dishes when possible
- Consider variety if they've been ordering similar things
- Reference their order history when relevant

Keep responses conversational and concise (2-4 paragraphs max).`
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`API Key configured: ${!!process.env.ANTHROPIC_API_KEY}`);
  console.log(`Database URL configured: ${!!process.env.DATABASE_URL}`);
});
