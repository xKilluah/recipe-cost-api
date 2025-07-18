// index.js

const express       = require('express');
const mongoose      = require('mongoose');
const dotenv        = require('dotenv');
const rateLimit     = require('express-rate-limit');
const morgan        = require('morgan');
const Joi           = require('joi');

// Load env vars
dotenv.config();

const app  = express();
const port = process.env.PORT || 3000;

// ---- MIDDLEWARE ----

// Logging
app.use(morgan('tiny'));

// Rate Limit (100 req/min)
app.use(rateLimit({
  windowMs: 60_000,
  max: 100,
  message: { error: 'Too many requests, please try again later.' }
}));

// JSON parser
app.use(express.json());

// API-key check
const requireApiKey = (req, res, next) => {
  const key = req.header('x-api-key');
  if (!key || key !== process.env.API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
};

// Wrap async routes to catch errors
const asyncHandler = fn => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

// ---- DB SETUP ----

mongoose
  .connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ Connected to MongoDB'))
  .catch(err => console.error('❌ MongoDB connection error:', err));

// ---- MONGOOSE MODEL ----

const recipeSchema = new mongoose.Schema({
  recipe_name: { type: String, required: true, unique: true },
  servings:    { type: Number, required: true },
  ingredients: [{
    name:      { type: String, required: true },
    quantity:  { type: Number, required: true },
    unit:      { type: String, required: true },
    unit_cost: { type: Number, required: true }
  }]
});
const Recipe = mongoose.model('Recipe', recipeSchema);

// ---- JOI SCHEMAS ----

const ingredientSchema = Joi.object({
  name:      Joi.string().required(),
  quantity:  Joi.number().positive().required(),
  unit:      Joi.string().required(),
  unit_cost: Joi.number().precision(4).min(0).required()
});

const calculateCostSchema = Joi.object({
  recipe_name:      Joi.string().required(),
  servings:         Joi.number().integer().min(1).required(),
  ingredients:      Joi.array().items(ingredientSchema).min(1).required(),
  markup_multiplier:Joi.number().positive().optional()
});

const saveRecipeSchema = calculateCostSchema;

const getRecipesQuerySchema = Joi.object({
  name:       Joi.string().optional(),
  ingredient: Joi.string().optional(),
  page:       Joi.number().integer().min(1).optional(),
  limit:      Joi.number().integer().min(1).optional()
});

const nameParamSchema = Joi.object({
  name: Joi.string().required()
});

// ---- ROUTES ----

// Health check (no API key)
app.get('/', (req, res) => {
  res.send('👨‍🍳 Recipe Cost API is up!');
});

// All following routes require API key
app.use(requireApiKey);

// Calculate cost
app.post('/calculate-cost', asyncHandler(async (req, res) => {
    const { error, value } = calculateCostSchema.validate(
        req.body,
        { abortEarly: false }
      );
  if (error) return res.status(400).json({ error: error.details.map(d => d.message) });

  const { recipe_name, servings, ingredients, markup_multiplier } = value;
  const totalCost      = ingredients.reduce((sum, i) => sum + i.quantity * i.unit_cost, 0);
  const costPerServing = totalCost / servings;
  const multiplier     = markup_multiplier || 3;
  const suggestedPrice = costPerServing * multiplier;
  const profitMargin   = suggestedPrice - costPerServing;
  const foodCostPct    = (costPerServing / suggestedPrice) * 100;

  res.json({
    recipe_name,
    total_cost:                    +totalCost.toFixed(2),
    cost_per_serving:              +costPerServing.toFixed(2),
    suggested_price_per_serving:   +suggestedPrice.toFixed(2),
    profit_margin_per_serving:     +profitMargin.toFixed(2),
    food_cost_percent:             +foodCostPct.toFixed(2)
  });
}));

// Save recipe
app.post('/save-recipe', asyncHandler(async (req, res) => {
    const { error, value } = saveRecipeSchema.validate(
        req.body,
        { abortEarly: false }
      );
  if (error) return res.status(400).json({ error: error.details.map(d => d.message) });

  const recipe = new Recipe(value);
  await recipe.save();
  res.status(201).json({ message: 'Recipe saved successfully.' });
}));

// List recipes
app.get('/recipes', asyncHandler(async (req, res) => {
    const { error, value } = getRecipesQuerySchema.validate(
        req.query,
        { abortEarly: false }
      );
  if (error) return res.status(400).json({ error: error.details.map(d => d.message) });

  const { name, ingredient, page = 1, limit = 10 } = value;
  const filter = {};
  if (name)       filter.recipe_name        = { $regex: name, $options: 'i' };
  if (ingredient) filter['ingredients.name'] = { $regex: ingredient, $options: 'i' };

  const skip = (page - 1) * limit;
  const [data, total] = await Promise.all([
    Recipe.find(filter).skip(skip).limit(limit),
    Recipe.countDocuments(filter)
  ]);

  res.json({ data, total, page, pages: Math.ceil(total / limit) });
}));

// Get one by name
app.get('/recipes/:name', asyncHandler(async (req, res) => {
    const { error, value } = nameParamSchema.validate(
        req.params,
        { abortEarly: false }
      );
  if (error) return res.status(400).json({ error: error.details.map(d => d.message) });

  const recipe = await Recipe.findOne({ recipe_name: value.name });
  if (!recipe) return res.status(404).json({ error: 'Recipe not found.' });
  res.json(recipe);
}));

// Update by name
app.put('/recipes/:name', asyncHandler(async (req, res) => {
  const { error: pErr, value: pVal } = nameParamSchema.validate(req.params);
  if (pErr) return res.status(400).json({ error: pErr.details.map(d => d.message) });

  const { error: bErr, value: bVal } = saveRecipeSchema.validate(req.body);
  if (bErr) return res.status(400).json({ error: bErr.details.map(d => d.message) });

  const updated = await Recipe.findOneAndUpdate(
    { recipe_name: pVal.name },
    bVal,
    { new: true, runValidators: true }
  );
  if (!updated) return res.status(404).json({ error: 'Recipe not found.' });
  res.json(updated);
}));

// Delete by name
app.delete('/recipes/:name', asyncHandler(async (req, res) => {
  const { error, value } = nameParamSchema.validate(req.params);
  if (error) return res.status(400).json({ error: error.details.map(d => d.message) });

  const deleted = await Recipe.findOneAndDelete({ recipe_name: value.name });
  if (!deleted) return res.status(404).json({ error: 'Recipe not found.' });
  res.json({ message: 'Recipe deleted successfully.' });
}));

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Error handler
app.use((err, req, res, next) => {
  console.error(err);
  if (err.isJoi) {
    return res.status(400).json({ error: err.details.map(d => d.message) });
  }
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

// Start server
app.listen(port, () => console.log(`🚀 API running on port ${port}`));