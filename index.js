const express       = require('express');
const mongoose      = require('mongoose');
const dotenv        = require('dotenv');
const rateLimit     = require('express-rate-limit');
const morgan        = require('morgan');
const swaggerJsdoc  = require('swagger-jsdoc');
const swaggerUi     = require('swagger-ui-express');

// ─── Load environment variables ────────────────────────────────────────────────
dotenv.config();

// ─── App init ──────────────────────────────────────────────────────────────────
const app  = express();
const port = process.env.PORT || 3000;

// ─── Logging + Rate-Limit ──────────────────────────────────────────────────────
app.use(morgan('combined'));

app.use(rateLimit({
  windowMs: 60 * 1000,   // 1 minute
  max:      100,         // limit each IP to 100 requests per window
  message:  { error: 'Too many requests, please try again later.' }
}));

// ─── Body parsing ──────────────────────────────────────────────────────────────
app.use(express.json());

// ─── Simple API-Key middleware ─────────────────────────────────────────────────
const requireApiKey = (req, res, next) => {
  const apiKey = req.header('x-api-key');
  if (!apiKey || apiKey !== process.env.API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
};

// ─── MongoDB connection ────────────────────────────────────────────────────────
mongoose
  .connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ Connected to MongoDB'))
  .catch(err => console.error('❌ MongoDB connection error:', err));

// ─── Recipe schema & model ────────────────────────────────────────────────────
const recipeSchema = new mongoose.Schema({
  recipe_name: { type: String, required: true, unique: true },
  servings:    { type: Number, required: true },
  ingredients: [
    {
      name:      { type: String, required: true },
      quantity:  { type: Number, required: true },
      unit:      { type: String, required: true },
      unit_cost: { type: Number, required: true }
    }
  ]
});
const Recipe = mongoose.model('Recipe', recipeSchema);

// ─── Swagger/OpenAPI setup ────────────────────────────────────────────────────
const swaggerDefinition = {
  openapi: '3.0.0',
  info: {
    title:       'Recipe Cost API',
    version:     '1.0.0',
    description: 'Save recipes, calculate food costs, and manage them via CRUD'
  },
  servers: [
    {
      url: process.env.BASE_URL || `http://localhost:${port}`,
      description: 'Primary API server'
    }
  ]
};

const swaggerOptions = {
  definition: swaggerDefinition,
  apis:       ['./index.js']    // <-- this file, so add JSDoc comments here if you like
};

const swaggerSpec = swaggerJsdoc(swaggerOptions);
app.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// ─── Public health check (no API key) ─────────────────────────────────────────
app.get('/', (req, res) => {
  res.send('👨‍🍳 Recipe Cost API is up and running!');
});

// ─── Require API key for everything below ─────────────────────────────────────
app.use(requireApiKey);

// ─── Calculate cost & pricing ─────────────────────────────────────────────────
app.post('/calculate-cost', (req, res) => {
  const { recipe_name, servings, ingredients, markup_multiplier } = req.body;
  if (!recipe_name || !servings || !Array.isArray(ingredients)) {
    return res.status(400).json({ error: 'Invalid input.' });
  }

  const totalCost = ingredients.reduce(
    (sum, item) => sum + item.quantity * item.unit_cost,
    0
  );
  const multiplier = typeof markup_multiplier === 'number' && markup_multiplier > 0
    ? markup_multiplier
    : 3;

  const costPerServing           = totalCost / servings;
  const suggestedPricePerServing = costPerServing * multiplier;
  const profitMarginPerServing   = suggestedPricePerServing - costPerServing;
  const foodCostPercent          = (costPerServing / suggestedPricePerServing) * 100;

  res.json({
    recipe_name,
    total_cost:                   parseFloat(totalCost.toFixed(2)),
    cost_per_serving:             parseFloat(costPerServing.toFixed(2)),
    suggested_price_per_serving:  parseFloat(suggestedPricePerServing.toFixed(2)),
    profit_margin_per_serving:    parseFloat(profitMarginPerServing.toFixed(2)),
    food_cost_percent:            parseFloat(foodCostPercent.toFixed(2))
  });
});

// ─── Create (save) a recipe ───────────────────────────────────────────────────
app.post('/save-recipe', async (req, res) => {
  try {
    const recipe = new Recipe(req.body);
    await recipe.save();
    res.status(201).json({ message: 'Recipe saved successfully.' });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ error: 'Recipe name already exists.' });
    }
    res.status(500).json({ error: 'Failed to save recipe.', details: err.message });
  }
});

// ─── Read all recipes (with pagination + filters) ─────────────────────────────
app.get('/recipes', async (req, res) => {
  try {
    const { name, ingredient, page = 1, limit = 10 } = req.query;
    const filter = {};
    if (name)       filter.recipe_name    = { $regex: name,       $options: 'i' };
    if (ingredient) filter['ingredients.name'] = { $regex: ingredient, $options: 'i' };

    const pageNum  = parseInt(page, 10);
    const limitNum = parseInt(limit, 10);
    const skip     = (pageNum - 1) * limitNum;

    const [recipes, total] = await Promise.all([
      Recipe.find(filter).skip(skip).limit(limitNum),
      Recipe.countDocuments(filter)
    ]);
    const pages = Math.ceil(total / limitNum);

    res.json({ data: recipes, total, page: pageNum, pages });
  } catch {
    res.status(500).json({ error: 'Failed to fetch recipes.' });
  }
});

// ─── Read one by name ──────────────────────────────────────────────────────────
app.get('/recipes/:name', async (req, res) => {
  try {
    const recipe = await Recipe.findOne({ recipe_name: req.params.name });
    if (!recipe) return res.status(404).json({ error: 'Recipe not found.' });
    res.json(recipe);
  } catch {
    res.status(500).json({ error: 'Failed to fetch recipe.' });
  }
});

// ─── Update by name ────────────────────────────────────────────────────────────
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

// ─── Delete by name ────────────────────────────────────────────────────────────
app.delete('/recipes/:name', async (req, res) => {
  try {
    const result = await Recipe.findOneAndDelete({ recipe_name: req.params.name });
    if (!result) return res.status(404).json({ error: 'Recipe not found.' });
    res.json({ message: 'Recipe deleted successfully.' });
  } catch {
    res.status(500).json({ error: 'Failed to delete recipe.' });
  }
});

// ─── Start server ──────────────────────────────────────────────────────────────
app.listen(port, () => {
  console.log(`🚀 API running on port ${port}`);
});