const express = require('express');
const mongoose = require('mongoose');
const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());

// 🔌 Connect to MongoDB
mongoose.connect('mongodb+srv://trkonstantinostkp:ITF3JVi7c7o9bCAj@cluster0.zdiglid.mongodb.net/recipesdb?retryWrites=true&w=majority&appName=Cluster0', {
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

// 🧾 Create the model
const Recipe = mongoose.model('Recipe', recipeSchema);

// 👋 Welcome route
app.get('/', (req, res) => {
  res.send('👨‍🍳 Welcome to the Recipe Cost API + MongoDB!');
});

// 💸 Calculate cost
app.post('/calculate-cost', (req, res) => {
  const { recipe_name, servings, ingredients, markup_multiplier } = req.body;

  if (!recipe_name || !servings || !Array.isArray(ingredients)) {
    return res.status(400).json({ error: 'Invalid input.' });
  }

  const totalCost = ingredients.reduce((sum, item) => {
    return sum + item.quantity * item.unit_cost;
  }, 0);

  const multiplier =
    typeof markup_multiplier === 'number' && markup_multiplier > 0
      ? markup_multiplier
      : 3;

  const costPerServing = totalCost / servings;
  const suggestedPricePerServing = costPerServing * multiplier;
  const profitMarginPerServing = suggestedPricePerServing - costPerServing;
  const foodCostPercent = (costPerServing / suggestedPricePerServing) * 100;

  return res.json({
    recipe_name,
    total_cost: parseFloat(totalCost.toFixed(2)),
    cost_per_serving: parseFloat(costPerServing.toFixed(2)),
    suggested_price_per_serving: parseFloat(suggestedPricePerServing.toFixed(2)),
    profit_margin_per_serving: parseFloat(profitMarginPerServing.toFixed(2)),
    food_cost_percent: parseFloat(foodCostPercent.toFixed(2))
  });
});

// 💾 Save to MongoDB
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

// 📦 Fetch all from MongoDB
app.get('/recipes', async (req, res) => {
  try {
    const recipes = await Recipe.find();
    res.json(recipes);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch recipes.' });
  }
});

// 🚀 Start server
app.listen(port, () => {
  console.log(`API is running on http://localhost:${port}`);
});