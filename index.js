const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

app.post('/calculate-cost', (req, res) => {
  const { recipe_name, servings, ingredients } = req.body;

  if (!recipe_name || !servings || !ingredients || !Array.isArray(ingredients)) {
    return res.status(400).json({ error: 'Invalid input' });
  }

  let totalCost = 0;

  ingredients.forEach(item => {
    totalCost += item.quantity * item.unit_cost;
  });

  const costPerServing = totalCost / servings;
  const suggestedPrice = costPerServing * 3; // 3x markup
  const profitMargin = suggestedPrice - costPerServing;
  const foodCostPercent = ((costPerServing / suggestedPrice) * 100).toFixed(2);

  res.json({
    recipe_name,
    total_cost: Number(totalCost.toFixed(2)),
    cost_per_serving: Number(costPerServing.toFixed(2)),
    suggested_price_per_serving: Number(suggestedPrice.toFixed(2)),
    profit_margin_per_serving: Number(profitMargin.toFixed(2)),
    food_cost_percent: Number(foodCostPercent)
  });
});

app.listen(PORT, () => {
  console.log(`API is running on http://localhost:${PORT}`);
});