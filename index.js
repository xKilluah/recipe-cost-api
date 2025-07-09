// index.js

const express = require('express');
const mongoose = require('mongoose');
const dotenv = require('dotenv');
const rateLimit = require('express-rate-limit');
const morgan = require('morgan');
const swaggerUi = require('swagger-ui-express');
const swaggerJSDoc = require('swagger-jsdoc');

// Load environment variables
dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

// --------------------
// Swagger / OpenAPI setup
// --------------------
const swaggerDefinition = {
  openapi: '3.0.0',
  info: {
    title: 'Recipe Cost API',
    version: '1.0.0',
    description: 'A simple API for saving recipes and calculating food costs',
  },
  servers: [
    { url: `http://localhost:${port}`, description: 'Local server' },
    { url: process.env.SWAGGER_URL || `https://${process.env.RENDER_EXTERNAL_URL}`, description: 'Production server' }
  ],
};

const swaggerOptions = {
  swaggerDefinition,
  apis: ['./index.js'], // ← This file contains the @openapi annotations
};

const swaggerSpec = swaggerJSDoc(swaggerOptions);

// Expose Swagger UI at /docs (no API key required)
app.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// --------------------
// Middleware
// --------------------

// HTTP request logging
app.use(morgan('combined'));

// Rate limiting: max 100 requests per minute per IP
app.use(rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  message: { error: 'Too many requests, please try again later.' },
}));

// Parse JSON bodies
app.use(express.json());

// Simple API key auth
const requireApiKey = (req, res, next) => {
  const apiKey = req.header('x-api-key');
  if (!apiKey || apiKey !== process.env.API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
};

// --------------------
// MongoDB connection
// --------------------
mongoose
  .connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ Connected to MongoDB'))
  .catch(err => console.error('❌ MongoDB connection error:', err));

// --------------------
// Recipe schema & model
// --------------------
const recipeSchema = new mongoose.Schema({
  recipe_name: { type: String, required: true, unique: true },
  servings:    { type: Number, required: true },
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

// --------------------
// Routes
// --------------------

// No auth needed
/**
 * @openapi
 * /:
 *   get:
 *     summary: Health-check endpoint
 *     responses:
 *       200:
 *         description: API is running
 */
app.get('/', (req, res) => {
  res.send('👨‍🍳 Recipe Cost API with key auth is running!');
});


 // … other middleware …

+// Swagger UI (public, no API key needed)
+app.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

 // Require API key for all subsequent routes
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
 *             required: [recipe_name, servings, ingredients]
 *             properties:
 *               recipe_name:
 *                 type: string
 *               servings:
 *                 type: integer
 *               ingredients:
 *                 type: array
 *                 items:
 *                   type: object
 *                   required: [name, quantity, unit, unit_cost]
 *                   properties:
 *                     name:
 *                       type: string
 *                     quantity:
 *                       type: number
 *                     unit:
 *                       type: string
 *                     unit_cost:
 *                       type: number
 *               markup_multiplier:
 *                 type: number
 *                 description: Optional markup; defaults to 3
 *     responses:
 *       200:
 *         description: Cost calculation result
 */
app.post('/calculate-cost', (req, res) => {
  const { recipe_name, servings, ingredients, markup_multiplier } = req.body;
  if (!recipe_name || !servings || !Array.isArray(ingredients)) {
    return res.status(400).json({ error: 'Invalid input.' });
  }
  const totalCost = ingredients.reduce((sum, i) => sum + i.quantity * i.unit_cost, 0);
  const multiplier = typeof markup_multiplier === 'number' && markup_multiplier > 0 ? markup_multiplier : 3;
  const costPerServing  = totalCost / servings;
  const suggestedPrice  = costPerServing * multiplier;
  const profitMargin    = suggestedPrice - costPerServing;
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
 *     summary: Save a new recipe
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [recipe_name, servings, ingredients]
 *             properties:
 *               recipe_name: { type: string }
 *               servings:    { type: integer }
 *               ingredients:
 *                 type: array
 *                 items:
 *                   type: object
 *     responses:
 *       201:
 *         description: Recipe saved successfully
 *       409:
 *         description: Recipe name already exists
 */
app.post('/save-recipe', async (req, res) => {
  try {
    const recipe = new Recipe(req.body);
    await recipe.save();
    res.status(201).json({ message: 'Recipe saved successfully.' });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: 'Recipe name already exists.' });
    res.status(500).json({ error: 'Failed to save recipe.', details: err.message });
  }
});

/**
 * @openapi
 * /recipes:
 *   get:
 *     summary: List recipes with optional filters & pagination
 *     parameters:
 *       - in: query
 *         name: name
 *         schema: { type: string }
 *         description: Filter by recipe_name substring
 *       - in: query
 *         name: ingredient
 *         schema: { type: string }
 *         description: Filter by ingredient name substring
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *         description: Page number
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 10 }
 *         description: Results per page
 *     responses:
 *       200:
 *         description: Paginated list of recipes
 */
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
      Recipe.countDocuments(filter),
    ]);
    const pages = Math.ceil(total / limitNum);
    res.json({ data: recipes, total, page: pageNum, pages });
  } catch {
    res.status(500).json({ error: 'Failed to fetch recipes.' });
  }
});

/**
 * @openapi
 * /recipes/{name}:
 *   get:
 *     summary: Fetch a recipe by exact name
 *     parameters:
 *       - in: path
 *         name: name
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Recipe object }
 *       404: { description: Recipe not found }
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
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content: { 'application/json': { schema: { type: object } } }
 *     responses:
 *       200: { description: Updated recipe }
 *       404: { description: Recipe not found }
 */
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

/**
 * @openapi
 * /recipes/{name}:
 *   delete:
 *     summary: Delete a recipe by name
 *     parameters:
 *       - in: path
 *         name: name
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Recipe deleted successfully }
 *       404: { description: Recipe not found }
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

// --------------------
// Start server
// --------------------
app.listen(port, () => {
  console.log(`🚀 API running on port ${port}`);
});