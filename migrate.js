#!/usr/bin/env node

/**
 * Migration Script: Old Schema → Unified Meals Schema
 * 
 * This script will:
 * 1. Create new unified tables (meals, meal_items)
 * 2. Migrate existing takeout orders → meals
 * 3. Import all recipes from recipes.json → meals
 * 4. Keep old tables as backups (_backup suffix)
 */

require('dotenv').config();
const fs = require('fs');
const { pool, initializeDatabase, migrateExistingData, importRecipes } = require('./database_unified');

async function runMigration() {
  console.log('\n🚀 Starting database migration to unified schema...\n');
  
  try {
    // Step 1: Create new tables
    console.log('📋 Step 1: Creating unified tables...');
    await initializeDatabase();
    
    // Step 2: Migrate existing takeout data
    console.log('\n📋 Step 2: Migrating existing takeout orders...');
    await migrateExistingData();
    
    // Step 3: Import recipes
    console.log('\n📋 Step 3: Importing recipes from JSON...');
    const recipesPath = process.argv[2] || '/mnt/user-data/uploads/recipes.json';
    
    if (fs.existsSync(recipesPath)) {
      const recipes = JSON.parse(fs.readFileSync(recipesPath, 'utf8'));
      await importRecipes(recipes);
    } else {
      console.log('⚠️  No recipes.json found at', recipesPath);
      console.log('   Skipping recipe import. You can import later.');
    }
    
    // Step 4: Verify migration
    console.log('\n📋 Step 4: Verifying migration...');
    const stats = await pool.query(`
      SELECT 
        meal_type,
        COUNT(*) as count
      FROM meals
      GROUP BY meal_type
    `);
    
    console.log('\n✅ Migration complete!\n');
    console.log('📊 Database Summary:');
    stats.rows.forEach(row => {
      console.log(`   ${row.meal_type}: ${row.count} meals`);
    });
    
    console.log('\n💡 Next steps:');
    console.log('   1. Update server.js to use the new database schema');
    console.log('   2. Test the app thoroughly');
    console.log('   3. Once confirmed working, you can drop the *_backup tables\n');
    
  } catch (error) {
    console.error('\n❌ Migration failed:', error);
    console.error('\n💡 Your original data is safe. Check the error and try again.\n');
    process.exit(1);
  } finally {
    await pool.end();
  }
}

// Run it!
runMigration();
