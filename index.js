const express = require('express');
const mongoose = require('mongoose');
const dotenv = require('dotenv');
const rateLimit = require('express-rate-limit');
const morgan = require('morgan');
const swaggerJsdoc = require('swagger-jsdoc');
const swaggerUi = require('swagger-ui-express');

// Load environment variables
dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

// --- Swagger/OpenAPI setup ---
const swaggerDefinition = {
  openapi: '3.0.0',
  info: {
    title: 'Recipe Cost API',
    version: '1.0.0',
    description: 'Save recipes, calculate food costs, and manage them via CRUD',
  },
  servers: [
    {
      // BASE_URL can be set in your environment, otherwise falls back to your Render URL
      url: process.env.BASE_URL || `https://recipe-cost-api.onrender.com`,
      description: 'Primary API server',
    },
  ],
};

const swaggerOptions = {
  definition: swaggerDefinition,
  apis: ['./index.js'], // look for JSDoc comments in this file
};

const swaggerSpec = swaggerJsdoc(swaggerOptions);
app.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// --- Middleware ---
app.use(morgan('combined'));         // request logging
app.use(
  rateLimit({                       // rate limit: 100 req/minute/IP
    windowMs: 60 * 1000,
    max: 100,
    message: { error: 'Too many requests, please try again later.' },
  })
);
app.use(express.json());            // body parser

// API-key check
const requireApiKey = (req, res, next) => {
  const apiKey = req.header('x-api-key');
  if (!apiKey || apiKey !== process.env.API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
};

// --- Database connection ---
mongoose
  .connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ Connected to MongoDB'))
  .catch(err => console.error('❌ MongoDB connection error:', err));

// --- Mongoose model ---
const recipeSchema = new mongoose.Schema({
  recipe_name: { type: String, required: true, unique: true },
  servings:     { type: Number, required: true },
  ingredients: [
    {
      name:      { type: String, required: true },
      quantity:  { type: Number, required: true },
      unit:      { type: String, required: true },
      unit_cost: { type: Number, required: true },
    },
  ],
});
const Recipe = mongoose.model('Recipe', recipeSchema);

// --- Routes & JSDoc annotations ---

/**
 * @openapi
 * /:
 *   get:
 *     summary: Health-check endpoint
 *     responses:
 *       200:
 *         description: API is up and running
 */
app.get('/', (req, res) => {
  res.send('👨‍🍳 Recipe Cost API with key auth is running!');
});

// from here on, enforce API key
app.use(requireApiKey);

/**
 * @openapi
 * /calculate-cost:
 *   post:
 *     summary: Calculate cost and pricing for a recipe
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - recipe_name
 *               - servings
 *               - ingredients
 *             properties:
 *               recipe_name:
 *                 type: string
 *               servings:
 *                 type: number
 *               ingredients:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     name:
 *                       type: string
 *                     quantity:
 *                       type: number
 *                     unit_cost:
 *                       type: number
 *               markup_multiplier:
 *                 type: number
 *     responses:
 *       200:
 *         description: Calculated cost details
 */
app.post('/calculate-cost', (req, res) => {
  const { recipe_name, servings, ingredients, markup_multiplier } = req.body;
  if (!recipe_name || !servings || !Array.isArray(ingredients)) {
    return res.status(400).json({ error: 'Invalid input.' });
  }
  const totalCost = ingredients.reduce((sum, i) => sum + i.quantity * i.unit_cost, 0);
  const multiplier = (typeof markup_multiplier === 'number' && markup_multiplier > 0)
    ? markup_multiplier
    : 3;
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

/**
 * @openapi
 * /save-recipe:
 *   post:
 *     summary: Save a new recipe to the database
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/Recipe'
 *     responses:
 *       201:
 *         description: Recipe saved successfully
 */
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

/**
 * @openapi
 * /recipes:
 *   get:
 *     summary: List recipes with optional name or ingredient filter & pagination
 *     parameters:
 *       - in: query
 *         name: name
 *         schema:
 *           type: string
 *       - in: query
 *         name: ingredient
 *         schema:
 *           type: string
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Array of recipe documents
 */
app.get('/recipes', async (req, res) => {
  try {
    const { name, ingredient, page = 1, limit = 10 } = req.query;
    const filter = {};
    if (name)       filter.recipe_name = { $regex: name, $options: 'i' };
    if (ingredient) filter['ingredients.name'] = { $regex: ingredient, $options: 'i' };

    const pageNum = parseInt(page, 10);
    const limitNum = parseInt(limit, 10);
    const skip = (pageNum - 1) * limitNum;

    const [data, total] = await Promise.all([
      Recipe.find(filter).skip(skip).limit(limitNum),
      Recipe.countDocuments(filter),
    ]);
    const pages = Math.ceil(total / limitNum);

    res.json({ data, total, page: pageNum, pages });
  } catch {
    res.status(500).json({ error: 'Failed to fetch recipes.' });
  }
});

/**
 * @openapi
 * /recipes/{name}:
 *   get:
 *     summary: Fetch a single recipe by exact name
 *     parameters:
 *       - in: path
 *         name: name
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: A single recipe document
 */
app.get('/recipes/:name', async (req, res) => {
  try {
    const recipe = await Recipe.findOne({ recipe_name: req.params.name });
    if (!recipe) return res.status(404).json({ error: 'Recipe not found.' });
    res.json(recipe);
  } catch {
    res.status(500).json({ error: 'Failed to fetch recipe.' });
  }
});

/**
 * @openapi
 * /recipes/{name}:
 *   put:
 *     summary: Update a recipe by name
 *     parameters:
 *       - in: path
 *         name: name
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/Recipe'
 *     responses:
 *       200:
 *         description: The updated recipe
 */
app.put('/recipes/:name', async (req, res) => {
  try {
    const updated = await Recipe.findOneAndUpdate(
      { recipe_name: req.params.name },
      req.body,
      { new: true, runValidators: true }
    );
    if (!updated) return res.status(404).json({ error: 'Recipe not found.' });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update recipe.', details: err.message });
  }
});

/**
 * @openapi
 * /recipes/{name}:
 *   delete:
 *     summary: Delete a recipe by name
 *     parameters:
 *       - in: path
 *         name: name
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Deletion confirmation
 */
app.delete('/recipes/:name', async (req, res) => {
  try {
    const result = await Recipe.findOneAndDelete({ recipe_name: req.params.name });
    if (!result) return res.status(404).json({ error: 'Recipe not found.' });
    res.json({ message: 'Recipe deleted successfully.' });
  } catch {
    res.status(500).json({ error: 'Failed to delete recipe.' });
  }
});

// --- Start server ---
app.listen(port, () => {
  console.log(`🚀 API running on port ${port}`);
});