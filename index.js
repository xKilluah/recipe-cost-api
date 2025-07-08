const express = require('express');
const mongoose = require('mongoose');
const dotenv = require('dotenv');

// Load environment variables from .env
dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

// Middleware to parse JSON
app.use(express.json());

// Connect to MongoDB Atlas
mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
})
.then(() => console.log('✅ Connected to MongoDB'))
.catch((err) => console.error('❌ MongoDB connection error:', err));

// Define Recipe schema and model
const recipeSchema = new mongoose.Schema({
  recipe_name: { type: String, required: true, unique: true },
  servings: { type: Number, required: true },
  ingredients: [
    {
      name: { type: String, required: true },
      quantity: { type: Number, required: true },
      unit: { type: String, required: true },
      unit_cost: { type: Number, required: true }
    }
  ],
});

const Recipe = mongoose.model('Recipe', recipeSchema);

// Home route
app.get('/', (req, res) => {
  res.send('👨‍🍳 Recipe Cost API with full CRUD is running!');
});

// Calculate cost and pricing
app.post('/calculate-cost', (req, res) => {
  const { recipe_name, servings, ingredients, markup_multiplier } = req.body;
  if (!recipe_name || !servings || !Array.isArray(ingredients)) {
    return res.status(400).json({ error: 'Invalid input.' });
  }
  const totalCost = ingredients.reduce((sum, item) => sum + item.quantity * item.unit_cost, 0);
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

// Create (Save) recipe
app.post('/save-recipe', async (req, res) => {
  try {
    const recipe = new Recipe(req.body);
    await recipe.save();
    res.status(201).json({ message: 'Recipe saved to MongoDB!' });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ error: 'Recipe name already exists.' });
    }
    res.status(500).json({ error: 'Failed to save recipe.', details: err.message });
  }
});

// Read (Fetch) all recipes with optional filters
app.get('/recipes', async (req, res) => {
  try {
    const { ingredient, name } = req.query;
    const filter = {};
    if (ingredient) filter['ingredients.name'] = { $regex: ingredient, $options: 'i' };
    if (name) filter['recipe_name'] = { $regex: name, $options: 'i' };
    const recipes = await Recipe.find(filter);
    res.json(recipes);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch recipes.' });
  }
});

// Read (Fetch) one recipe by exact name
app.get('/recipes/:name', async (req, res) => {
  try {
    const recipe = await Recipe.findOne({ recipe_name: req.params.name });
    if (!recipe) return res.status(404).json({ error: 'Recipe not found.' });
    res.json(recipe);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch recipe.' });
  }
});

// Update recipe by name
app.put('/recipes/:name', async (req, res) => {
  try {
    const updates = req.body;
    const recipe = await Recipe.findOneAndUpdate(
      { recipe_name: req.params.name },
      updates,
      { new: true, runValidators: true }
    );
    if (!recipe) return res.status(404).json({ error: 'Recipe not found.' });
    res.json(recipe);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update recipe.', details: err.message });
  }
});

// Delete recipe by name
app.delete('/recipes/:name', async (req, res) => {
  try {
    const result = await Recipe.findOneAndDelete({ recipe_name: req.params.name });
    if (!result) return res.status(404).json({ error: 'Recipe not found.' });
    res.json({ message: 'Recipe deleted successfully.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete recipe.' });
  }
});

// Start server
app.listen(port, () => {
  console.log(`🚀 API running on port ${port}`);
});
