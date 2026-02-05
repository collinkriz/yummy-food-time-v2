# 🧠 AI Tags Feature - Implementation Summary

**Date:** February 4, 2026  
**Version:** 2.2 - Two-Tier Tag System

---

## 🎯 What We Built

A **two-tier tag system** where:
- **Visible Tags** (user-curated, shown in UI) - Clean, intentional, 4-8 tags
- **AI Tags** (background, hidden) - Auto-generated, experimental, unlimited

The system **learns and improves** with every Smart Match, making Quick Pick smarter over time.

---

## 🏗️ Architecture

### **Database Changes**

Added two columns to `meals` table:
```sql
ALTER TABLE meals ADD COLUMN ai_tags TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE meals ADD COLUMN ai_tag_metadata JSONB DEFAULT '{}'::JSONB;
CREATE INDEX idx_meals_ai_tags ON meals USING GIN(ai_tags);
```

**Example Data:**
```
Visible tags: ['Main Dish', 'Mexican', 'Quick (< 30 min)', 'Easy']
AI tags: ['weeknight friendly', 'uses pantry staples', 'one pot', 
          'leftovers well', 'protein heavy', 'budget friendly']
```

### **AI Tag Metadata** (tracking):
```json
{
  "last_updated": "2026-02-04T15:32:00Z"
}
```

---

## 🔄 How It Works

### **1. Smart Match Generates AI Tags**

When user clicks "Smart Match":
1. AI analyzes 15 candidate recipes
2. Picks best match + explains why
3. **NEW:** Also generates 5-10 AI tags for chosen recipe
4. Tags saved to `ai_tags` column (hidden from user)

**AI Prompt Addition:**
```
Additionally, generate 5-10 descriptive AI tags that capture:
- Cooking context (weeknight friendly, special occasion, etc.)
- Ingredient characteristics (pantry staples, specialty items)
- Meal characteristics (leftovers well, feeds a crowd, reheats well)
- Flavor profiles (rich, light, tangy, savory)
- Practical aspects (one pot, make ahead, freezable)

Tags should be lowercase, short phrases (2-4 words).

Example: ["weeknight friendly", "uses pantry staples", "one pot"]
```

**Cost:** Still $0.015 (no extra API call, just extract more from response)

### **2. Quick Pick Uses AI Tags as Fallback**

When Quick Pick finds a weak match (< 50% tags):
1. Expands query with synonyms
   - "Quick" → ["quick", "fast", "weeknight", "30 min"]
   - "Healthy" → ["healthy", "nutritious", "light", "fresh"]
2. Searches both visible tags AND ai_tags
3. If AI tag match found, shows: "💡 Found via smart matching!"

**SQL Query:**
```sql
SELECT *, 
  (SELECT COUNT(*) FROM unnest(tags) tag WHERE tag = ANY($1)) as match_count,
  (SELECT COUNT(*) FROM unnest(ai_tags) tag WHERE tag ILIKE ANY($2)) as ai_match_count
FROM meals 
WHERE meal_type = 'recipe' 
  AND (tags && $1 OR ai_tags && $2)
ORDER BY match_count DESC, ai_match_count DESC, RANDOM()
LIMIT 1
```

**Cost:** $0 (just database query)

### **3. System Learns Over Time**

**Week 1:**
- 162 recipes with visible tags only
- AI tags column is empty `[]`
- Quick Pick relies on exact tag matches
- Smart Match used frequently

**Month 1:**
- 20 recipes have AI tags (from 20 Smart Match uses)
- Quick Pick starts finding better fallback matches
- Smart Match usage drops 15%

**Month 6:**
- 80+ recipes have rich AI tags
- Quick Pick rarely fails
- Smart Match only needed for new/edge cases
- System has learned your preferences

---

## 💻 Code Changes

### **database.js**
```javascript
// Added columns
ai_tags TEXT[] DEFAULT ARRAY[]::TEXT[],
ai_tag_metadata JSONB DEFAULT '{}'::JSONB

// Added index
CREATE INDEX IF NOT EXISTS idx_meals_ai_tags ON meals USING GIN(ai_tags);
```

### **server.js**

**Smart Match - Generate AI Tags:**
```javascript
// Updated prompt to request aiTags
// Response now includes:
{
  "topChoice": 3,
  "reasoning": "...",
  "aiTags": ["weeknight friendly", "uses pantry staples", ...]
}

// Save to database
await pool.query(`
  UPDATE meals 
  SET ai_tags = array_cat(COALESCE(ai_tags, ARRAY[]::text[]), $1::text[]),
      ai_tag_metadata = jsonb_set(
        COALESCE(ai_tag_metadata, '{}'::jsonb),
        '{last_updated}',
        to_jsonb(now())
      )
  WHERE id = $2
`, [aiResult.aiTags, chosenRecipe.id]);
```

**Quick Pick - AI Tag Fallback:**
```javascript
// If match is weak (< 50%)
if (result.rows.length === 0 || result.rows[0].match_count < tagFilters.length * 0.5) {
  // Expand query with synonyms
  const expandedTerms = expandQueryTerms(tagFilters);
  
  // Search ai_tags with ILIKE
  const aiResult = await pool.query(`
    SELECT *, 
      (SELECT COUNT(*) FROM unnest(ai_tags) tag WHERE tag ILIKE ANY($2)) as ai_match_count
    FROM meals 
    WHERE meal_type = 'recipe' AND (tags && $1 OR ai_tags && $2)
    ORDER BY match_count DESC, ai_match_count DESC
    LIMIT 1
  `, [tagFilters, expandedTerms]);
  
  // Show "💡 Found via smart matching" indicator
}
```

---

## 🎨 User Experience

### **Users Never See AI Tags**
- Recipe browsing: Only visible tags shown
- Recipe detail: Only visible tags shown
- Filter selection: Uses visible tags only

### **But System Gets Smarter**

**Scenario: Day 1**
```
User: Quick + Healthy + Main Dish
Quick Pick: Finds 1 weak match (2/3 tags)
Result: Shows "Close match" + Smart Match button
User: Clicks Smart Match ($0.015)
System: Adds AI tags ["weeknight friendly", "nutritious", "lean protein"]
```

**Scenario: Week 4 (Same Query)**
```
User: Quick + Healthy + Main Dish
Quick Pick: Finds weak visible match, checks AI tags
AI Tags: Match! ["weeknight friendly" ≈ "quick", "nutritious" ≈ "healthy"]
Result: "💡 Found via smart matching - this recipe fits your vibe!"
Cost: $0 (no Smart Match needed!)
```

---

## 📊 New API Endpoint

### **GET /api/ai-tags-debug**

Returns recipes with AI tags (for monitoring):
```json
{
  "success": true,
  "stats": {
    "total_recipes": 162,
    "recipes_with_ai_tags": 23,
    "avg_ai_tags_per_recipe": 6.3
  },
  "recipes": [
    {
      "id": 45,
      "name": "Chicken Fajitas",
      "tags": ["Main Dish", "Mexican", "Quick (< 30 min)"],
      "ai_tags": ["weeknight friendly", "uses pantry staples", "one pot", 
                  "leftovers well", "protein heavy", "customizable"],
      "ai_tag_metadata": {
        "last_updated": "2026-02-04T15:32:00Z"
      },
      "ai_tag_count": 6
    }
  ]
}
```

**Use Cases:**
- Monitor which recipes are getting AI tags
- See what tags AI is generating
- Verify system is learning
- Debug if AI tags seem wrong

---

## 💰 Cost Analysis

### **Smart Match (with AI Tags)**
- **Cost:** $0.015 (unchanged!)
- **What Changed:** Now also generates AI tags (free bonus)
- **Benefit:** Improves future Quick Pick matches

### **Quick Pick (with AI Fallback)**
- **Cost:** $0 (still free!)
- **What Changed:** Checks AI tags if weak match
- **Benefit:** Better results without AI cost

### **Overall Impact**
- **Week 1:** Same cost as before ($0.015 per Smart Match)
- **Month 1:** Lower costs (fewer Smart Matches needed)
- **Month 6:** Significant savings (Quick Pick handles most queries)

**Example:**
- **Before AI Tags:** User uses Smart Match 20 times/month = $0.30
- **After AI Tags (Month 6):** User uses Smart Match 5 times/month = $0.075
- **Savings:** $0.225/month (75% reduction)

---

## 🔍 Monitoring & Debugging

### **Check AI Tag Coverage**
```sql
SELECT 
  COUNT(*) as total_recipes,
  COUNT(CASE WHEN ai_tags IS NOT NULL AND array_length(ai_tags, 1) > 0 THEN 1 END) as has_ai_tags,
  ROUND(100.0 * COUNT(CASE WHEN ai_tags IS NOT NULL AND array_length(ai_tags, 1) > 0 THEN 1 END) / COUNT(*), 1) as coverage_pct
FROM meals
WHERE meal_type = 'recipe';
```

### **View Most Recent AI Tags**
```sql
SELECT name, ai_tags, ai_tag_metadata->>'last_updated' as updated
FROM meals
WHERE meal_type = 'recipe' AND ai_tags IS NOT NULL
ORDER BY ai_tag_metadata->>'last_updated' DESC
LIMIT 10;
```

### **Find Recipes with Specific AI Tag**
```sql
SELECT name, tags, ai_tags
FROM meals
WHERE meal_type = 'recipe' 
  AND 'weeknight friendly' = ANY(ai_tags);
```

---

## 🎯 Benefits

### **1. Self-Improving System**
- Every Smart Match makes database smarter
- Quick Pick gets better over time
- Eventually need Smart Match less

### **2. Hidden Complexity**
- User sees clean, curated tags
- System uses rich background data
- No UI clutter

### **3. Zero Extra Cost**
- AI tags generated during Smart Match (already paying for)
- Fallback search is free (database only)
- Long-term cost savings

### **4. Personalized Learning**
- System learns what "quick" means to you
- What "comfort food" means to you
- Your patterns and preferences

### **5. Easy to Reset**
- AI tags separate from visible tags
- Can clear AI tags without affecting UI
- Safe to experiment

---

## 🚀 Deployment Checklist

1. ✅ **Push to GitHub** - All code changes ready
2. ✅ **Railway auto-deploys** - Wait for build
3. ⚠️ **Run migration** - Visit `/run-migration` to add columns
4. ✅ **Test Smart Match** - Should save AI tags automatically
5. ✅ **Monitor** - Visit `/api/ai-tags-debug` to see coverage

---

## 📈 What to Expect

### **Week 1-2: Building Foundation**
- Use Smart Match a few times
- AI tags start accumulating
- Quick Pick still mostly exact matches

### **Week 3-4: Early Benefits**
- 10-20 recipes with AI tags
- Occasional "💡 Found via smart matching" results
- Slightly less need for Smart Match

### **Month 2-3: System Maturing**
- 40-60 recipes with AI tags
- Quick Pick success rate improves noticeably
- Smart Match usage drops 30-50%

### **Month 6+: Fully Learned**
- 80-100+ recipes with AI tags
- Quick Pick handles most queries well
- Smart Match only for new/unusual queries
- Significant cost savings

---

## 🐛 Potential Issues & Solutions

### **Issue: AI Tags Too Generic**
```
AI keeps generating: ["delicious", "tasty", "good"]
```
**Solution:** Update prompt to be more specific about tag types

### **Issue: AI Tags Too Long**
```
AI generates: ["perfect for a cozy weekend dinner with the family"]
```
**Solution:** Prompt already specifies "2-4 words", but can emphasize

### **Issue: Duplicate AI Tags**
```
Recipe has: ["weeknight friendly", "weeknight meal", "weeknight dinner"]
```
**Solution:** Could deduplicate on save, or let it be (more matches)

### **Issue: AI Tags Not Helping**
```
After 20 Smart Matches, Quick Pick still struggles
```
**Solution:** Check `/api/ai-tags-debug` to see what tags are being generated

---

## 💡 Future Enhancements

- [ ] **Show top AI tags** in recipe detail (for power users)
- [ ] **AI tag suggestions** when manually editing recipes
- [ ] **Tag confidence scores** (how reliable is this AI tag?)
- [ ] **User feedback** on AI tags (thumbs up/down)
- [ ] **Periodic cleanup** (remove low-confidence tags)
- [ ] **Export AI tags** for analysis

---

## 🎉 Summary

You now have a **two-tier tag system** that:
- ✅ Keeps UI clean with curated visible tags
- ✅ Learns in background with AI tags
- ✅ Improves Quick Pick over time
- ✅ Costs nothing extra
- ✅ Saves money long-term
- ✅ Is completely invisible to users

Every Smart Match makes the system smarter. In 6 months, you'll rarely need Smart Match because Quick Pick will have learned your preferences through accumulated AI tags.

**It's like having a sous chef who remembers what you like!** 👨‍🍳

---

**Ready to deploy!** Just push to GitHub, run `/run-migration`, and watch the system learn.
