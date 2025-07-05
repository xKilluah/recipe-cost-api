const express = require('express');
const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());

// In-memory recipe store
let savedRecipes = [];

// Welcome route
app.get('/', (req, res) => {
  res.send('👨‍🍳 Welcome to the Recipe Cost API!');
});

// Calculate cost and pricing for a recipe
app.post('/calculate-cost', (req, res) => {
  const { recipe_name, servings, ingredients, markup_multiplier } = req.body;

  if (!recipe_name || !servings || !Array.isArray(ingredients)) {
    return res.status(400).json({
      error: 'Invalid input: recipe_name, servings, and ingredients are required.',
    });
  }

  for (let item of ingredients) {
    if (
      !item.name ||
      typeof item.quantity !== 'number' ||
      typeof item.unit_cost !== 'number'
    ) {
      return res.status(400).json({
        error: 'Each ingredient must have a name, numeric quantity, and unit_cost.',
      });
    }
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

// Save a recipe to memory
app.post('/save-recipe', (req, res) => {
  const recipe = req.body;

  if (!recipe.recipe_name || !recipe.servings || !Array.isArray(recipe.ingredients)) {
    return res.status(400).json({ error: 'Missing required fields.' });
  }

  const exists = savedRecipes.find(r => r.recipe_name === recipe.recipe_name);
  if (exists) {
    return res.status(409).json({ error: 'Recipe with this name already exists.' });
  }

  savedRecipes.push(recipe);
  return res.status(201).json({ message: 'Recipe saved successfully.' });
});

// Get all saved recipes
app.get('/recipes', (req, res) => {
  return res.json(savedRecipes);
});

// Start the server
app.listen(port, () => {
  console.log(`API is running on http://localhost:${port}`);
});