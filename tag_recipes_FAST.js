const fs = require('fs');

// Load recipes
const recipes = JSON.parse(fs.readFileSync('/mnt/user-data/uploads/recipes.json', 'utf8'));

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
            return { ...recipe, tags };
        }
        
        console.error(`Failed to parse tags for ${recipe.name}`);
        return { ...recipe, tags: recipe.ai_category || [] };
        
    } catch (error) {
        console.error(`Error tagging ${recipe.name}:`, error.message);
        return { ...recipe, tags: recipe.ai_category || [] };
    }
}

async function processAllRecipes() {
    console.log(`\n🏷️  Starting PARALLEL AI-powered recipe tagging for ${recipes.length} recipes...\n`);
    console.log(`⚡ Processing 10 recipes at a time for maximum speed!\n`);
    
    const startTime = Date.now();
    const taggedRecipes = [];
    let successCount = 0;
    let errorCount = 0;
    
    const BATCH_SIZE = 10;  // Process 10 at once
    
    for (let i = 0; i < recipes.length; i += BATCH_SIZE) {
        const batchNum = Math.floor(i / BATCH_SIZE) + 1;
        const totalBatches = Math.ceil(recipes.length / BATCH_SIZE);
        const batch = recipes.slice(i, i + BATCH_SIZE);
        
        console.log(`\n📦 Batch ${batchNum}/${totalBatches} - Processing recipes ${i + 1}-${Math.min(i + BATCH_SIZE, recipes.length)}...`);
        
        // Process batch in parallel
        const results = await Promise.all(
            batch.map(async (recipe, idx) => {
                const recipeNum = i + idx + 1;
                process.stdout.write(`  [${recipeNum}/${recipes.length}] ${recipe.name.substring(0, 35).padEnd(35)} ... `);
                
                const tagged = await tagRecipe(recipe);
                
                if (tagged.tags && tagged.tags.length > 0) {
                    successCount++;
                    console.log(`✅ ${tagged.tags.length} tags`);
                } else {
                    errorCount++;
                    console.log(`⚠️  fallback`);
                }
                
                return tagged;
            })
        );
        
        taggedRecipes.push(...results);
        
        // Small delay between batches to be nice to the API
        if (i + BATCH_SIZE < recipes.length) {
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }
    
    // Save updated recipes
    fs.writeFileSync('/home/claude/recipes_tagged.json', JSON.stringify(taggedRecipes, null, 2));
    
    const duration = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
    
    console.log(`\n✅ Tagging complete in ${duration} minutes!`);
    console.log(`   Success: ${successCount} recipes`);
    console.log(`   Errors: ${errorCount} recipes`);
    console.log(`   Output: /home/claude/recipes_tagged.json\n`);
    
    // Show tag statistics
    const allTags = {};
    taggedRecipes.forEach(r => {
        (r.tags || []).forEach(tag => {
            allTags[tag] = (allTags[tag] || 0) + 1;
        });
    });
    
    console.log('\n📊 Tag Distribution:');
    Object.entries(allTags)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 20)
        .forEach(([tag, count]) => {
            console.log(`   ${tag}: ${count}`);
        });
}

// Run the tagging process
processAllRecipes().catch(console.error);
