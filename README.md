# Yummy Food Time v2 - Complete

A food delivery order tracker with AI extraction, ratings, assignments, order history, and AI chatbot for personalized recommendations.

## All Features
- ✅ **AI Image Extraction** - Upload any food delivery receipt
- ✅ **Database Storage** - All orders saved permanently
- ✅ **Ratings** - Rate each item 1-5 stars
- ✅ **Assignment** - Track who ate what (Collin or Emily)
- ✅ **Notes** - Add personal notes for each item
- ✅ **Order History** - View all past orders
- ✅ **Edit Orders** - Fix any mistakes in restaurant, items, prices, ratings, or totals
- ✅ **Delete Orders** - Remove orders you don't want
- ✅ **AI Chatbot** - Get personalized food recommendations based on your history

## Supported Apps
- DoorDash, Uber Eats, Grubhub, Postmates, Instacart, and more!

## Quick Deploy to Railway

### Step 1: Update Your Existing Deployment

If you already have the v1 deployed:

1. Go to your Railway dashboard
2. Click on your `yummy-food-time-v2` project
3. Click on your service
4. Go to "Settings"
5. Scroll to "Source Repo"
6. You'll need to update the code in your GitHub repo (see below)

### Step 2: Update GitHub Repository

1. Go to your GitHub repo: `yummy-food-time-v2`
2. Delete the old files (or delete the whole repo and recreate it)
3. Download and extract the new ZIP file from this deployment
4. Upload all new files:
   - `server.js` (updated)
   - `database.js` (NEW)
   - `package.json` (updated with database)
   - `public/index.html` (completely new)
5. Commit the changes

### Step 3: Add PostgreSQL Database

This is the most important new step!

1. In Railway, go to your project
2. Click "**+ New**" → "**Database**" → "**Add PostgreSQL**"
3. Wait for it to provision (30 seconds)
4. Railway will automatically add `DATABASE_URL` environment variable
5. Your app will auto-redeploy and connect to the database!

### Step 4: Verify Environment Variables

Make sure you have both:
- ✅ `ANTHROPIC_API_KEY` (from before)
- ✅ `DATABASE_URL` (automatically added by PostgreSQL)

### Step 5: Test Your New Features!

1. Open your Railway URL
2. **Upload Tab**: Upload a receipt, rate items, assign them, add notes, save
3. **History Tab**: View all saved orders, click to see details
   - Click "Edit Order" to modify any field (restaurant, address, items, prices, ratings, notes, totals)
   - Add or remove items as needed
   - Click "Save Changes" when done
   - Or click "Delete" to remove the order entirely
4. **Chat Tab**: Ask the AI chatbot for food recommendations!
   - Try: "What should I order tonight?"
   - Try: "Recommend something based on my favorites"
   - Try: "I'm craving Italian food, any suggestions?"
   - The AI knows your entire order history and ratings!

## How the Chatbot Works

The AI chatbot has access to:
- All your past orders and restaurants
- Your ratings for each item
- Your notes and preferences
- Who ate what (Collin vs Emily preferences)

It uses this to give personalized recommendations like:
- "Based on your 5-star rating of the Hot Honey Chicken, you might love..."
- "You haven't tried Thai food yet, want to explore?"
- "Collin seems to prefer spicy items, how about..."

## Alternative: Fresh Deployment

If you want to start fresh:

1. Create new GitHub repo: `yummy-food-time-v2`
2. Upload all files from the ZIP
3. Go to Railway → "New Project"
4. Deploy from GitHub repo
5. Add PostgreSQL database
6. Add environment variable: `ANTHROPIC_API_KEY`
7. Generate domain

## Local Testing (Optional)

```bash
# Install dependencies
npm install

# Set environment variables
export ANTHROPIC_API_KEY=your_key_here
export DATABASE_URL=postgresql://user:pass@localhost/dbname

# Start server
npm start
```

## Database Schema

The app creates two tables automatically:

**orders**
- id, restaurant, address, delivery_service
- subtotal, delivery_fee, service_fee, tax, discount, tip, total
- order_date, created_at

**order_items**
- id, order_id (foreign key)
- item_name, price
- assigned_to, rating, notes
- created_at

## API Endpoints

- `POST /extract-order` - Extract info from receipt image
- `POST /orders` - Save order with ratings
- `GET /orders` - Get all orders
- `GET /orders/:id` - Get single order
- `PUT /orders/:id` - Update entire order (all fields)
- `PATCH /order-items/:id` - Update item rating/assignment/notes
- `DELETE /orders/:id` - Delete order
- `POST /chat` - Chat with AI for food recommendations
- `GET /health` - Health check

## Troubleshooting

**"Database connection failed"**
- Make sure PostgreSQL database is added in Railway
- Check that `DATABASE_URL` is in your environment variables

**"Tables don't exist"**
- The app creates tables automatically on first run
- Check Railway logs for any database errors

**"Orders not saving"**
- Make sure database is running
- Check Railway logs for errors

## Cost

- Railway: $5/month (includes database)
- Anthropic API: ~$0.03 per image
- Total for moderate use: $5-10/month

Enjoy tracking your food orders! 🍕
