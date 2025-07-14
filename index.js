// index.js

const express = require('express');
const mongoose = require('mongoose');
const dotenv = require('dotenv');
const rateLimit = require('express-rate-limit');
const morgan = require('morgan');
const Joi = require('joi');

// Load environment variables
dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

// Minimal request logging
app.use(morgan('tiny'));

// Rate limiting: max 100 requests per minute per IP
const limiter = rateLimit({
  windowMs: 60_000, // 1 minute
  max: 100,
  message: { error: 'Too many requests, please try again later.' }
});
app.use(limiter);

// Parse JSON bodies
app.use(express.json());

// Simple API key authentication
const requireApiKey = (req, res, next) => {
  const apiKey = req.header('x-api-key');
  if (!apiKey || apiKey !== process.env.API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
};

// Connect to MongoDB
mongoose
  .connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ Connected to MongoDB'))
  .catch(err => console.error('❌ MongoDB connection error:', err));

// Define Recipe schema & model
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

// Joi validation schemas
const calculateCostSchema = Joi.object({
  recipe_name:      Joi.string().required(),
  servings:         Joi.number().integer().min(1).required(),
  ingredients:      Joi.array().items(
    Joi.object({
      name:      Joi.string().required(),
      quantity:  Joi.number().positive().required(),
      unit:      Joi.string().required(),
      unit_cost: Joi.number().precision(4).min(0).required()
    })
  ).min(1).required(),
  markup_multiplier: Joi.number().positive().optional()
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

// Public health-check endpoint
app.get('/', (req, res) => {
  res.send('👨‍🍳 Recipe Cost API is up and running!');
});

// Apply API key middleware for all endpoints below
app.use(requireApiKey);

// Calculate cost & pricing
app.post('/calculate-cost', (req, res) => {
  const { error, value } = calculateCostSchema.validate(req.body);
  if (error) {
    return res.status(400).json({ error: error.details.map(d => d.message) });
  }

  const { recipe_name, servings, ingredients, markup_multiplier } = value;
  const totalCost      = ingredients.reduce((sum, i) => sum + i.quantity * i.unit_cost, 0);
  const costPerServing = totalCost / servings;
  const multiplier      = markup_multiplier || 3;
  const suggestedPrice = costPerServing * multiplier;
  const profitMargin   = suggestedPrice - costPerServing;
  const foodCostPercent = (costPerServing / suggestedPrice) * 100;

  res.json({
    recipe_name,
    total_cost:                    +totalCost.toFixed(2),
    cost_per_serving:              +costPerServing.toFixed(2),
    suggested_price_per_serving:   +suggestedPrice.toFixed(2),
    profit_margin_per_serving:     +profitMargin.toFixed(2),
    food_cost_percent:             +foodCostPercent.toFixed(2)
  });
});

// Save a new recipe
app.post('/save-recipe', async (req, res) => {
  const { error, value } = saveRecipeSchema.validate(req.body);
  if (error) {
    return res.status(400).json({ error: error.details.map(d => d.message) });
  }

  try {
    const recipe = new Recipe(value);
    await recipe.save();
    res.status(201).json({ message: 'Recipe saved successfully.' });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ error: 'Recipe name already exists.' });
    }
    res.status(500).json({ error: 'Failed to save recipe.' });
  }
});

// List recipes with filters & pagination
app.get('/recipes', async (req, res) => {
  const { error, value } = getRecipesQuerySchema.validate(req.query);
  if (error) {
    return res.status(400).json({ error: error.details.map(d => d.message) });
  }

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
});

// Fetch single recipe by name
app.get('/recipes/:name', async (req, res) => {
  const { error, value } = nameParamSchema.validate(req.params);
  if (error) {
    return res.status(400).json({ error: error.details.map(d => d.message) });
  }

  const recipe = await Recipe.findOne({ recipe_name: value.name });
  if (!recipe) return res.status(404).json({ error: 'Recipe not found.' });
  res.json(recipe);
});

// Update a recipe by name
app.put('/recipes/:name', async (req, res) => {
  const paramCheck = nameParamSchema.validate(req.params);
  if (paramCheck.error) {
    return res.status(400).json({ error: paramCheck.error.details.map(d => d.message) });
  }

  const bodyCheck = saveRecipeSchema.validate(req.body);
  if (bodyCheck.error) {
    return res.status(400).json({ error: bodyCheck.error.details.map(d => d.message) });
  }

  const updated = await Recipe.findOneAndUpdate(
    { recipe_name: paramCheck.value.name },
    bodyCheck.value,
    { new: true, runValidators: true }
  );

  if (!updated) return res.status(404).json({ error: 'Recipe not found.' });
  res.json(updated);
});

// Delete a recipe by name
app.delete('/recipes/:name', async (req, res) => {
  const { error, value } = nameParamSchema.validate(req.params);
  if (error) {
    return res.status(400).json({ error: error.details.map(d => d.message) });
  }

  const deleted = await Recipe.findOneAndDelete({ recipe_name: value.name });
  if (!deleted) return res.status(404).json({ error: 'Recipe not found.' });
  res.json({ message: 'Recipe deleted successfully.' });
});

// Start server
app.listen(port, () => console.log(`🚀 API running on port ${port}`));