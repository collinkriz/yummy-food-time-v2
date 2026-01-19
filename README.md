# Yummy Food Time v2 Backend

A simple Node.js backend that extracts order information from food delivery receipts using Claude AI.

## Supported Apps
- ✅ DoorDash
- ✅ Uber Eats
- ✅ Grubhub
- ✅ Postmates
- ✅ Instacart
- ✅ Any food delivery app with receipt screenshots

## Features
- Upload food delivery receipt images
- Automatically detects which delivery service
- Extracts restaurant name, address, items, and prices
- Mobile-friendly web interface for testing

## Quick Deploy to Railway

### Step 1: Sign up for Railway (Free)
1. Go to https://railway.app
2. Click "Start a New Project"
3. Sign up with GitHub (free account, no credit card needed)

### Step 2: Get Your Claude API Key
1. Go to https://console.anthropic.com
2. Sign in or create an account
3. Go to "API Keys" section
4. Create a new API key
5. Copy it (you'll need it in Step 4)

### Step 3: Deploy to Railway
1. In Railway, click "Deploy from GitHub repo"
2. OR click "Deploy from Local" and upload this entire folder

### Step 4: Set Environment Variable
1. In your Railway project, click on your service
2. Go to "Variables" tab
3. Click "Add Variable"
4. Add: `ANTHROPIC_API_KEY` = (paste your API key)
5. Save

### Step 5: Get Your URL
1. Go to "Settings" tab
2. Click "Generate Domain"
3. Copy your URL (something like: `yourapp.up.railway.app`)

### Step 6: Test on Your Phone!
1. Open the URL on your phone
2. Upload a receipt from DoorDash, Uber Eats, Grubhub, or any food delivery app
3. Click "Extract Order Info"
4. See the magic happen! ✨

## Alternative: Deploy to Render

1. Go to https://render.com (free tier available)
2. Sign up/login
3. Click "New +" → "Web Service"
4. Connect this repository
5. Set these:
   - Build Command: `npm install`
   - Start Command: `npm start`
6. Add environment variable: `ANTHROPIC_API_KEY`
7. Deploy!

## Local Testing (Optional)

If you want to test locally first:

```bash
# Install dependencies
npm install

# Set your API key
export ANTHROPIC_API_KEY=your_key_here

# Start server
npm start
```

Then open http://localhost:3000 in your browser.

## What's Next?

Once this works on your phone:
1. ✅ Backend is proven to work
2. ✅ API integration is successful
3. 📱 Next: Build the React Native iOS app
4. 🎨 Add the assignment and rating features
5. 🚀 Launch your app!

## Troubleshooting

**Error: "API Key not configured"**
- Make sure you added the `ANTHROPIC_API_KEY` environment variable

**Error: "Failed to extract"**
- Check your API key is valid
- Make sure you have credits on your Anthropic account

**Can't access the URL**
- Wait 1-2 minutes for deployment to complete
- Check Railway/Render deployment logs for errors

## Cost

- Railway: Free tier gives you $5/month credit (plenty for testing)
- Anthropic API: Pay per use (~$0.03 per image)
- Total monthly cost for moderate use: $5-10

## Support

If you get stuck, share the error message and I'll help you troubleshoot!
