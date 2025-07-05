app.post('/calculate-cost', (req, res) => {
    const { recipe_name, servings, ingredients, markup_multiplier } = req.body;
  
    // Validate required fields
    if (!recipe_name || !servings || !Array.isArray(ingredients)) {
      return res.status(400).json({
        error: 'Invalid input: recipe_name, servings, and ingredients are required.',
      });
    }
  
    // Validate each ingredient
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
  
    // Calculate total cost
    const totalCost = ingredients.reduce((sum, item) => {
      return sum + item.quantity * item.unit_cost;
    }, 0);
  
    // Use provided markup or default to 3
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