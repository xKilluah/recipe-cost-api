// index.js

const express = require('express');
const mongoose = require('mongoose');
const dotenv = require('dotenv');

// Load environment variables
dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

// Parse JSON bodies
app.use(express.json());

// Simple API key authentication middleware
const requireApiKey = (req, res, next) => {
  const apiKey = req.header('x-api-key');
  if (!apiKey || apiKey !== process.env.API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
};

// ——————————————
// DEBUG: show exactly what URI we're using
console.log('→ [DEBUG] MONGODB_URI =', JSON.stringify(process.env.MONGODB_URI));
// ——————————————

mongoose
  .connect(process.env.MONGODB_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  })
  .then(() => console.log('✅ Connected to MongoDB'))
  .catch(err => console.error('❌ MongoDB connection error:', err));

// Recipe schema & model
const recipeSchema = new mongoose.Schema({
  recipe_name: { type: String, required: true, unique: true },
  servings: { type: Number, required: true },
  ingredients: [
    {
      name: String,
      quantity: Number,
      unit: String,
      unit_cost: Number,
    },
  ],
});
const Recipe = mongoose.model('Recipe', recipeSchema);

// Public health check
app.get('/', (req, res) => {
  res.send('👨‍🍳 Recipe Cost API with key auth is running!');
});

// All routes below require a valid x-api-key
app.use(requireApiKey);

// Calculate cost endpoint
app.post('/calculate-cost', (req, res) => {
  const { recipe_name, servings, ingredients, markup_multiplier } = req.body;
  if (!recipe_name || !servings || !Array.isArray(ingredients)) {
    return res.status(400).json({ error: 'Invalid input.' });
  }
  const totalCost = ingredients.reduce((sum, i) => sum + i.quantity * i.unit_cost, 0);
  const multiplier = typeof markup_multiplier === 'number' && markup_multiplier > 0 ? markup_multiplier : 3;
  const costPerServing = totalCost / servings;
  const suggestedPrice = costPerServing * multiplier;
  const profitMargin = suggestedPrice - costPerServing;
  const foodCostPercent = (costPerServing / suggestedPrice) * 100;
  res.json({
    recipe_name,
    total_cost: parseFloat(totalCost.toFixed(2)),
    cost_per_serving: parseFloat(costPerServing.toFixed(2)),
    suggested_price_per_serving: parseFloat(suggestedPrice.toFixed(2)),
    profit_margin_per_serving: parseFloat(profitMargin.toFixed(2)),
    food_cost_percent: parseFloat(foodCostPercent.toFixed(2)),
  });
});

// Create recipe
app.post('/save-recipe', async (req, res) => {
  try {
    const recipe = new Recipe(req.body);
    await recipe.save();
    res.status(201).json({ message: 'Recipe saved successfully.' });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: 'Recipe name already exists.' });
    res.status(500).json({ error: 'Failed to save recipe.', details: err.message });
  }
});

// Read all with optional filters
app.get('/recipes', async (req, res) => {
  try {
    const { name, ingredient } = req.query;
    const filter = {};
    if (name) filter.recipe_name = { $regex: name, $options: 'i' };
    if (ingredient) filter['ingredients.name'] = { $regex: ingredient, $options: 'i' };
    const recipes = await Recipe.find(filter);
    res.json(recipes);
  } catch {
    res.status(500).json({ error: 'Failed to fetch recipes.' });
  }
});

// Read one by name
app.get('/recipes/:name', async (req, res) => {
  try {
    const recipe = await Recipe.findOne({ recipe_name: req.params.name });
    if (!recipe) return res.status(404).json({ error: 'Recipe not found.' });
    res.json(recipe);
  } catch {
    res.status(500).json({ error: 'Failed to fetch recipe.' });
  }
});

// Update by name
app.put('/recipes/:name', async (req, res) => {
  try {
    const recipe = await Recipe.findOneAndUpdate(
      { recipe_name: req.params.name },
      req.body,
      { new: true, runValidators: true }
    );
    if (!recipe) return res.status(404).json({ error: 'Recipe not found.' });
    res.json(recipe);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update recipe.', details: err.message });
  }
});

// Delete by name
app.delete('/recipes/:name', async (req, res) => {
  try {
    const result = await Recipe.findOneAndDelete({ recipe_name: req.params.name });
    if (!result) return res.status(404).json({ error: 'Recipe not found.' });
    res.json({ message: 'Recipe deleted successfully.' });
  } catch {
    res.status(500).json({ error: 'Failed to delete recipe.' });
  }
});

// Start server
app.listen(port, () => {
  console.log(`🚀 API running on port ${port}`);
});