# 🚀 Yummy Food Time - Smart AI Update

**Date:** February 4, 2026  
**Version:** 2.1 - Smart AI with Cost Tracking

---

## 🎯 What's New

### 1. **Smart AI Recipe Recommendations** 🧠
Two-tier system for recipe recommendations:

#### **Quick Pick (FREE, Instant)**
- Improved tag-based matching
- Prioritizes recipes with MORE matching tags
- Shows match quality: "Perfect Match!", "Great Match!", or "Close Match"
- Offers Smart Match upgrade button if match isn't perfect
- Zero AI cost

#### **Smart Match (~$0.015 per use)**
- Claude AI analyzes 15 candidate recipes
- Considers ingredients, cook time, actual recipe content (not just tags!)
- Provides reasoning: "I picked this because..."
- Much more accurate than tag matching alone
- Small cost for way better results

### 2. **AI Cost Tracking System** 💰
Complete transparency on AI usage:

- New `ai_usage` database table tracks every AI call
- Real-time cost estimates for each feature
- Settings modal shows:
  - Today's spending + call count
  - This week's spending
  - This month's spending
  - All-time spending + total calls
  - Breakdown by feature (receipts, Smart Match, chat, etc.)

### 3. **Updated Recipe Filters** 📋
Changed from meal-type based to **course-based** filters:

**Page 1: What course?**
- 🍽️ Main Dish (includes soups)
- 🥗 Salad (as a full meal, not a side)
- 🥔 Side Dish
- 🍰 Dessert
- 🥙 Appetizer
- 🍲 Soup
- 🎲 Any Course

**Page 2: What vibe?**
- ⚡ Quick (< 30 min)
- 🥗 Healthy
- 🍗 Hearty/Filling
- 🎓 Complex
- 🧀 Comfort Food
- 🎲 Any Vibe

**Why course-based?** More reliable! Every recipe MUST have a course tag (required by AI tagging), so you'll get better matches.

### 4. **Settings Button on Homepage** ⚙️
- New "⚙️ Settings & AI Usage" button on homepage
- Modal with full AI usage breakdown
- Cost information for each feature
- Easy monitoring of monthly spending

---

## 📊 Cost Breakdown

| Feature | Cost | Type |
|---------|------|------|
| Receipt Extraction | $0.03 | Required |
| Quick Pick (recipes) | FREE | Optional (default) |
| Smart Match (recipes) | $0.015 | Optional (upgrade) |
| Past Orders (takeout) | FREE | Default |
| AI Takeout Suggestion | $0.01 | Optional |
| Chat Messages | $0.02 | Optional |

**Estimated Monthly Cost:** $5-15 for moderate use (Railway $5 + API usage)

---

## 🔧 Technical Changes

### **Database Updates**
```sql
-- New table for AI cost tracking
CREATE TABLE ai_usage (
  id SERIAL PRIMARY KEY,
  feature VARCHAR(50) NOT NULL,
  estimated_cost DECIMAL(10, 4) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

### **New Endpoints**
- `GET /api/ai-usage` - Returns AI usage statistics (today, week, month, all-time + breakdown)

### **Updated Endpoints**
- `GET /recommend?smartMatch=true` - Triggers Smart Match AI analysis instead of Quick Pick
- `POST /extract-order` - Now tracks AI usage ($0.03)
- `GET /ai-takeout-suggestion` - Now tracks AI usage ($0.01)

### **Filter ID Changes**
Updated filter IDs to match new course-based system:
- `main-dish` → "Main Dish"
- `salad` → "Salad"
- `side-dish` → "Side Dish"
- `dessert` → "Dessert"
- `appetizer` → "Appetizer"
- `soup` → "Soup"

---

## 🎨 User Experience Improvements

### **Recipe Recommendations**
1. User selects filters (e.g., "Main Dish" + "Quick" + "Healthy")
2. **Quick Pick shows immediately** (free, instant)
3. Shows match quality indicator
4. If not a perfect match, offers "🧠 Try Smart Match Instead (~$0.01)" button
5. User can upgrade to Smart Match if they want better results

**Match Quality Indicators:**
- 🌟 **Perfect Match!** - Recipe has ALL selected tags
- 👍 **Great Match!** - Recipe has 66%+ of selected tags
- 🤔 **Close Match** - Recipe has some selected tags

### **Settings Modal**
- Clean, organized display of AI spending
- Color-coded boxes (today = yellow, week = orange, month = green, all-time = purple)
- Per-feature breakdown with call counts
- Helpful "About AI Costs" section

---

## 📱 How Smart Match Works

### **The Process:**
1. Backend fetches 15 candidate recipes that match at least 1-2 filters
2. Sends them to Claude AI with this info:
   - Recipe name
   - Prep time, cook time, servings
   - Tags
   - First 200 characters of ingredients
3. AI analyzes considering:
   - How many criteria match
   - If cook time aligns with "Quick" request
   - If ingredients fit the vibe
   - Overall practicality
4. AI returns: Best choice + reasoning
5. User sees: Recipe + "🧠 Smart Match: [AI's reasoning]"

### **Example AI Reasoning:**
> "This recipe is perfect because it's truly a quick main dish that's healthy with lean protein and vegetables. The 25-minute total time makes it achievable for a weeknight."

---

## 🚀 Deployment Steps

1. **Update database schema:**
   ```
   Visit: /run-migration in your browser
   This will create the ai_usage table
   ```

2. **Deploy updated files to Railway:**
   - server.js
   - database.js
   - public/index.html
   - package.json (unchanged)

3. **Test the new features:**
   - Upload a receipt (should track $0.03)
   - Get a recipe recommendation (Quick Pick = free)
   - Click "Smart Match" button (should track $0.015)
   - Check Settings modal to see tracked costs

---

## 💡 Best Practices

### **For Cost Management:**
- Use Quick Pick first - it's free and often good enough!
- Use Smart Match when you want better results or Quick Pick isn't satisfying
- Monitor costs weekly in Settings modal
- Most users will spend $5-10/month total

### **For Recipe Recommendations:**
- Select 2-3 filters for best results (not too narrow)
- Course tags are most reliable (Main Dish, Salad, etc.)
- Vibe tags add personality (Quick, Comfort, etc.)
- If Quick Pick is "Close Match", try Smart Match for better accuracy

---

## 🐛 Known Issues & Limitations

1. **Smart Match requires internet** - If AI API is down, falls back to Quick Pick
2. **Cost tracking is estimates** - Actual API costs may vary slightly
3. **Settings modal doesn't auto-refresh** - Close and reopen to see latest stats

---

## 📝 Files Changed

### **Backend:**
- ✅ `database.js` - Added `ai_usage` table
- ✅ `server.js` - Added tracking, Smart Match logic, `/api/ai-usage` endpoint

### **Frontend:**
- ✅ `public/index.html` - Settings modal, updated filters, Smart Match button

### **Unchanged:**
- `package.json` - No new dependencies needed
- `recipes.json` - Database already has all recipes

---

## 🎉 What Users Will Love

1. **Transparency** - They can see exactly how much AI costs
2. **Control** - They choose when to use AI (free Quick Pick vs paid Smart Match)
3. **Better results** - Smart Match actually reads recipes, not just tags!
4. **Course-based filters** - More intuitive than meal times
5. **Match quality indicators** - Know how good the match is before clicking

---

## 🔮 Future Enhancements

- [ ] Budget alerts (e.g., "You've spent $5 this month")
- [ ] Smart Match auto-trigger if Quick Pick has low match
- [ ] Per-user cost tracking (Collin vs Emily)
- [ ] Export AI usage to CSV for analysis
- [ ] Weekly email summaries of AI costs

---

## 📞 Quick Reference

**To check AI costs:**
1. Click "⚙️ Settings & AI Usage" on homepage
2. View breakdown by day/week/month/all-time

**To use Smart Match:**
1. Select recipe filters
2. Click "Get Recommendation" (Quick Pick shows first)
3. If match isn't perfect, click "🧠 Try Smart Match Instead"
4. Pay ~$0.015 for AI-powered analysis

**To minimize costs:**
- Use Quick Pick for recipes (free!)
- Use past orders for takeout (free!)
- Only upgrade to Smart Match when needed
- Upload receipts sparingly ($0.03 each)

---

**Ready to deploy!** This update makes the app smarter while giving you full visibility into AI costs. The hybrid Quick Pick + Smart Match approach means most recommendations will be free, but users can pay a penny or two when they want the best possible match.

🎊 Happy cooking! 🎊
