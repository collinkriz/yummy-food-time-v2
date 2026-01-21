#!/usr/bin/env node

/**
 * Tag All Recipes in Database
 * 
 * This script will:
 * 1. Fetch all recipes from the database
 * 2. Use Claude API to generate 4-8 tags for each recipe
 * 3. Update the database with the new tags
 * 
 * Processes 10 recipes at a time for speed
 */

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

async function tagRecipe(recipe) {
    const prompt = `Analyze this recipe and assign appropriate tags. Choose tags that accurately describe this recipe based on reading the full content.

**Recipe Name:** ${recipe.name}

**Ingredients:**
${recipe.ingredients || 'N/A'}

**Directions:**
${recipe.directions ? recipe.directions.substring(0, 1000) : 'N/A'}

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

Carefully read the ingredients and directions. Return ONLY a JSON array of 4-8 selected tags that best describe this recipe. Include at least one from: Course, Time, Difficulty. Be accurate and thoughtful.

Example: ["Appetizer", "Vegetarian", "Quick (< 30 min)", "Easy", "Party Food", "Mexican", "No-Cook", "Fresh"]`;

    try {
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
            return { success: true, tags };
        }
        
        return { success: false, tags: recipe.tags || [] };
        
    } catch (error) {
        console.error(`Error tagging ${recipe.name}:`, error.message);
        return { success: false, tags: recipe.tags || [] };
    }
}

async function processAllRecipes() {
    console.log('\n🏷️  Starting AI-powered recipe tagging...\n');
    
    try {
        // Fetch all recipes from database
        console.log('📋 Fetching recipes from database...');
        const result = await pool.query(`
            SELECT id, name, ingredients, directions, prep_time, cook_time, servings, tags
            FROM meals
            WHERE meal_type = 'recipe'
            ORDER BY name ASC
        `);
        
        const recipes = result.rows;
        console.log(`✅ Found ${recipes.length} recipes\n`);
        console.log('⚡ Processing 10 recipes at a time for maximum speed!\n');
        
        const startTime = Date.now();
        let successCount = 0;
        let errorCount = 0;
        
        const BATCH_SIZE = 10;
        
        for (let i = 0; i < recipes.length; i += BATCH_SIZE) {
            const batchNum = Math.floor(i / BATCH_SIZE) + 1;
            const totalBatches = Math.ceil(recipes.length / BATCH_SIZE);
            const batch = recipes.slice(i, i + BATCH_SIZE);
            
            console.log(`\n📦 Batch ${batchNum}/${totalBatches} - Processing recipes ${i + 1}-${Math.min(i + BATCH_SIZE, recipes.length)}...`);
            
            // Process batch in parallel
            const results = await Promise.all(
                batch.map(async (recipe, idx) => {
                    const recipeNum = i + idx + 1;
                    process.stdout.write(`  [${recipeNum}/${recipes.length}] ${recipe.name.substring(0, 40).padEnd(40)} ... `);
                    
                    const result = await tagRecipe(recipe);
                    
                    if (result.success) {
                        // Update database with new tags
                        await pool.query(
                            'UPDATE meals SET tags = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
                            [result.tags, recipe.id]
                        );
                        successCount++;
                        console.log(`✅ ${result.tags.length} tags`);
                        return { id: recipe.id, tags: result.tags };
                    } else {
                        errorCount++;
                        console.log(`⚠️  fallback`);
                        return { id: recipe.id, tags: recipe.tags };
                    }
                })
            );
            
            // Small delay between batches to be nice to the API
            if (i + BATCH_SIZE < recipes.length) {
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }
        
        const duration = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
        
        console.log(`\n✅ Tagging complete in ${duration} minutes!`);
        console.log(`   Success: ${successCount} recipes`);
        console.log(`   Errors: ${errorCount} recipes`);
        
        // Show tag statistics
        console.log('\n📊 Tag Distribution:');
        const statsResult = await pool.query(`
            SELECT unnest(tags) as tag, COUNT(*) as count
            FROM meals
            WHERE meal_type = 'recipe' AND tags IS NOT NULL
            GROUP BY tag
            ORDER BY count DESC
            LIMIT 20
        `);
        
        statsResult.rows.forEach(row => {
            console.log(`   ${row.tag}: ${row.count}`);
        });
        
        console.log('\n🎉 All done! Your recipes now have comprehensive AI tags!\n');
        
    } catch (error) {
        console.error('\n❌ Error:', error);
    } finally {
        await pool.end();
    }
}

// Run the tagging process
processAllRecipes().catch(console.error);
