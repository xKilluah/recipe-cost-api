const express = require('express');
const mongoose = require('mongoose');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());

// 🔌 Connect to MongoDB
mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
})
.then(() => console.log('✅ Connected to MongoDB'))
.catch((err) => console.error('❌ MongoDB connection error:', err));

// 🍲 Define the Recipe schema
const recipeSchema = new mongoose.Schema({
  recipe_name: { type: String, required: true, unique: true },
  servings: { type: Number, required: true },
  ingredients: [
    {
      name: String,
      quantity: Number,
      unit: String,
      unit_cost: Number
    }
  ]
});

const Recipe = mongoose.model('Recipe', recipeSchema);

// Welcome Route
app.get('/', (req, res) => {
  res.send('👨‍🍳 Welcome to the Recipe Cost API + MongoDB!');
});

// Calculate Cost Route
app.post('/calculate-cost', (req, res) => {
  const { recipe_name, servings, ingredients, markup_multiplier } = req.body;

  if (!recipe_name || !servings || !Array.isArray(ingredients)) {
    return res.status(400).json({ error: 'Invalid input.' });
  }

  const totalCost = ingredients.reduce((sum, item) => {
    return sum + item.quantity * item.unit_cost;
  }, 0);

  const multiplier = typeof markup_multiplier === 'number' && markup_multiplier > 0 ? markup_multiplier : 3;
  const costPerServing = totalCost / servings;
  const suggestedPrice = costPerServing * multiplier;
  const profitMargin = suggestedPrice - costPerServing;
  const foodCostPercent = (costPerServing / suggestedPrice) * 100;

  res.json({
    recipe_name,
    total_cost: +totalCost.toFixed(2),
    cost_per_serving: +costPerServing.toFixed(2),
    suggested_price_per_serving: +suggestedPrice.toFixed(2),
    profit_margin_per_serving: +profitMargin.toFixed(2),
    food_cost_percent: +foodCostPercent.toFixed(2)
  });
});

// Save Recipe Route
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

// Get All Recipes Route
app.get('/recipes', async (req, res) => {
  try {
    const recipes = await Recipe.find();
    res.json(recipes);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch recipes.' });
  }
});

// Start Server
app.listen(port, () => {
  console.log(`🚀 API is running on http://localhost:${port}`);
});