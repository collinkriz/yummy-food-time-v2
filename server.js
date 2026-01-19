const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

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

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    hasApiKey: !!process.env.ANTHROPIC_API_KEY 
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`API Key configured: ${!!process.env.ANTHROPIC_API_KEY}`);
});
