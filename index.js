// index.js

const express           = require('express');
const mongoose          = require('mongoose');
const dotenv            = require('dotenv');
const rateLimit         = require('express-rate-limit');
const morgan            = require('morgan');
const helmet            = require('helmet');
const cors              = require('cors');
const mongoSanitize     = require('express-mongo-sanitize');
const xssClean          = require('xss-clean');
const Joi               = require('joi');
const swaggerJsdoc      = require('swagger-jsdoc');
const swaggerUi         = require('swagger-ui-express');
const Sentry            = require('@sentry/node');

dotenv.config();

const app  = express();
const port = process.env.PORT || 3000;

/* ─────────────────────────── SENTRY ─────────────────────────── */

let profilingIntegration; // optional, only if package is installed
try {
  profilingIntegration = require('@sentry/profiling-node').profilingIntegration;
} catch (_) {
  // profiling not installed — that's fine
}

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.SENTRY_ENVIRONMENT || 'production',
  tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE || 0.02),
  profilesSampleRate: Number(process.env.SENTRY_PROFILES_SAMPLE_RATE || 0), // set >0 only if you want profiling
  integrations: [
    Sentry.httpIntegration && Sentry.httpIntegration(),   // v8-safe HTTP tracing
    profilingIntegration && profilingIntegration(),       // optional profiling
  ].filter(Boolean),
  beforeSend(event) {
    // redact API key if it ever appears
    if (event.request?.headers && event.request.headers['x-api-key']) {
      event.request.headers['x-api-key'] = '[REDACTED]';
    }
    return event;
  },
});

/* ───────────────────────── MIDDLEWARE ───────────────────────── */

app.use(helmet());
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'PUT', 'DELETE'] }));
app.use(mongoSanitize());
app.use(xssClean());

app.use(morgan('tiny'));

app.use(rateLimit({
  windowMs: 60_000, // 1 minute
  max: 100,
  message: { error: 'Too many requests, please try again later.' },
}));

app.use(express.json({ limit: '100kb' }));

const requireApiKey = (req, res, next) => {
  const key = req.header('x-api-key');
  if (!key || key !== process.env.API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
};

const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

/* ───────────────────────── SWAGGER ──────────────────────────── */

const swaggerDefinition = {
  openapi: '3.0.0',
  info: {
    title: 'Recipe Cost API',
    version: '1.0.0',
    description: 'Calculate food costs & manage recipes',
  },
  servers: [
    {
      url: process.env.BASE_URL || `http://localhost:${port}`,
      description: 'Primary server',
    },
  ],
  components: {
    securitySchemes: {
      ApiKeyAuth: {
        type: 'apiKey',
        in: 'header',
        name: 'x-api-key',
      },
    },
    schemas: {
      Ingredient: {
        type: 'object',
        required: ['name', 'quantity', 'unit', 'unit_cost'],
        properties: {
          name: { type: 'string' },
          quantity: { type: 'number' },
          unit: { type: 'string' },
          unit_cost: { type: 'number' },
        },
      },
      CalculateCost: {
        type: 'object',
        required: ['recipe_name', 'servings', 'ingredients'],
        properties: {
          recipe_name: { type: 'string' },
          servings: { type: 'integer' },
          markup_multiplier: { type: 'number' },
          ingredients: {
            type: 'array',
            items: { $ref: '#/components/schemas/Ingredient' },
          },
        },
      },
    },
  },
  security: [{ ApiKeyAuth: [] }],
};

const swaggerSpec = swaggerJsdoc({
  swaggerDefinition,
  apis: ['./index.js'],
});

app.get('/openapi.json', (req, res) => res.json(swaggerSpec));
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec, { explorer: true }));

/* ───────────────────────── DATABASE ─────────────────────────── */

mongoose
  .connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ Connected to MongoDB'))
  .catch((err) => console.error('❌ MongoDB connection error:', err));

/* ───────────────────────── MONGOOSE ─────────────────────────── */

const recipeSchema = new mongoose.Schema({
  recipe_name: { type: String, required: true, unique: true },
  servings: { type: Number, required: true },
  ingredients: [
    {
      name: { type: String, required: true },
      quantity: { type: Number, required: true },
      unit: { type: String, required: true },
      unit_cost: { type: Number, required: true },
    },
  ],
});
const Recipe = mongoose.model('Recipe', recipeSchema);

/* ───────────────────────── JOI SCHEMAS ──────────────────────── */

const ingredientSchema = Joi.object({
  name: Joi.string().required(),
  quantity: Joi.number().positive().required(),
  unit: Joi.string().required(),
  unit_cost: Joi.number().min(0).precision(4).required(),
});

const calculateCostSchema = Joi.object({
  recipe_name: Joi.string().required(),
  servings: Joi.number().integer().min(1).required(),
  ingredients: Joi.array().items(ingredientSchema).min(1).required(),
  markup_multiplier: Joi.number().positive().optional(),
});

const saveRecipeSchema = calculateCostSchema;

const getRecipesQuerySchema = Joi.object({
  name: Joi.string().optional(),
  ingredient: Joi.string().optional(),
  page: Joi.number().integer().min(1).optional(),
  limit: Joi.number().integer().min(1).optional(),
});

const nameParamSchema = Joi.object({
  name: Joi.string().required(),
});

/* ───────────────────────── ROUTES ───────────────────────────── */

/**
 * @swagger
 * /:
 *   get:
 *     summary: Health check
 *     responses:
 *       200:
 *         description: API is up and running
 */
app.get('/', (req, res) => {
  res.send('👨‍🍳 Recipe Cost API is up!');
});

// Protect all subsequent routes
app.use(requireApiKey);

/**
 * @swagger
 * /calculate-cost:
 *   post:
 *     summary: Calculate total cost and pricing for a recipe
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/CalculateCost'
 *     responses:
 *       '200':
 *         description: Calculation result
 *       '400':
 *         description: Validation error
 *       '401':
 *         description: Unauthorized
 */
app.post(
  '/calculate-cost',
  asyncHandler(async (req, res) => {
    const { error, value } = calculateCostSchema.validate(req.body, { abortEarly: false });
    if (error) return res.status(400).json({ error: error.details.map((d) => d.message) });

    const { recipe_name, servings, ingredients, markup_multiplier } = value;
    const totalCost = ingredients.reduce((sum, i) => sum + i.quantity * i.unit_cost, 0);
    const costPerServing = totalCost / servings;
    const multiplier = markup_multiplier || 3;
    const suggestedPrice = costPerServing * multiplier;
    const profitMargin = suggestedPrice - costPerServing;
    const foodCostPct = (costPerServing / suggestedPrice) * 100;

    res.json({
      recipe_name,
      total_cost: +totalCost.toFixed(2),
      cost_per_serving: +costPerServing.toFixed(2),
      suggested_price_per_serving: +suggestedPrice.toFixed(2),
      profit_margin_per_serving: +profitMargin.toFixed(2),
      food_cost_percent: +foodCostPct.toFixed(2),
    });
  })
);

/**
 * @swagger
 * /save-recipe:
 *   post:
 *     summary: Save a new recipe
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/CalculateCost'
 *     responses:
 *       '201':
 *         description: Recipe saved
 *       '400':
 *         description: Validation error
 *       '401':
 *         description: Unauthorized
 *       '409':
 *         description: Recipe name already exists
 */
app.post(
  '/save-recipe',
  asyncHandler(async (req, res) => {
    const { error, value } = saveRecipeSchema.validate(req.body, { abortEarly: false });
    if (error) return res.status(400).json({ error: error.details.map((d) => d.message) });

    const recipe = new Recipe(value);
    await recipe.save();
    res.status(201).json({ message: 'Recipe saved successfully.' });
  })
);

/**
 * @swagger
 * /recipes:
 *   get:
 *     summary: List recipes with optional filters & pagination
 *     parameters:
 *       - in: query
 *         name: name
 *         schema:
 *           type: string
 *         description: Partial match on recipe name
 *       - in: query
 *         name: ingredient
 *         schema:
 *           type: string
 *         description: Partial match on ingredient name
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *         description: Page number
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *         description: Items per page
 *     responses:
 *       '200':
 *         description: List of recipes
 *       '401':
 *         description: Unauthorized
 */
app.get(
  '/recipes',
  asyncHandler(async (req, res) => {
    const { error, value } = getRecipesQuerySchema.validate(req.query, { abortEarly: false });
    if (error) return res.status(400).json({ error: error.details.map((d) => d.message) });

    const { name, ingredient, page = 1, limit = 10 } = value;
    const filter = {};
    if (name) filter.recipe_name = { $regex: name, $options: 'i' };
    if (ingredient) filter['ingredients.name'] = { $regex: ingredient, $options: 'i' };

    const skip = (page - 1) * limit;
    const [data, total] = await Promise.all([
      Recipe.find(filter).skip(skip).limit(limit),
      Recipe.countDocuments(filter),
    ]);

    res.json({ data, total, page, pages: Math.ceil(total / limit) });
  })
);

/**
 * @swagger
 * /recipes/{name}:
 *   get:
 *     summary: Get a recipe by name
 *     parameters:
 *       - in: path
 *         name: name
 *         required: true
 *         schema:
 *           type: string
 *         description: The recipe name
 *     responses:
 *       '200':
 *         description: Recipe object
 *       '404':
 *         description: Recipe not found
 *       '401':
 *         description: Unauthorized
 */
app.get(
  '/recipes/:name',
  asyncHandler(async (req, res) => {
    const { error, value } = nameParamSchema.validate(req.params, { abortEarly: false });
    if (error) return res.status(400).json({ error: error.details.map((d) => d.message) });

    const recipe = await Recipe.findOne({ recipe_name: value.name });
    if (!recipe) return res.status(404).json({ error: 'Recipe not found.' });
    res.json(recipe);
  })
);

/**
 * @swagger
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
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/CalculateCost'
 *     responses:
 *       '200':
 *         description: Updated recipe object
 *       '400':
 *         description: Validation error
 *       '404':
 *         description: Recipe not found
 *       '401':
 *         description: Unauthorized
 */
app.put(
  '/recipes/:name',
  asyncHandler(async (req, res) => {
    const { error: pErr, value: pVal } = nameParamSchema.validate(req.params, { abortEarly: false });
    if (pErr) return res.status(400).json({ error: pErr.details.map((d) => d.message) });

    const { error: bErr, value: bVal } = saveRecipeSchema.validate(req.body, { abortEarly: false });
    if (bErr) return res.status(400).json({ error: bErr.details.map((d) => d.message) });

    const updated = await Recipe.findOneAndUpdate(
      { recipe_name: pVal.name },
      bVal,
      { new: true, runValidators: true }
    );
    if (!updated) return res.status(404).json({ error: 'Recipe not found.' });
    res.json(updated);
  })
);

/**
 * @swagger
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
 *       '200':
 *         description: Deletion success message
 *       '404':
 *         description: Recipe not found
 *       '401':
 *         description: Unauthorized
 */
app.delete(
  '/recipes/:name',
  asyncHandler(async (req, res) => {
    const { error, value } = nameParamSchema.validate(req.params, { abortEarly: false });
    if (error) return res.status(400).json({ error: error.details.map((d) => d.message) });

    const deleted = await Recipe.findOneAndDelete({ recipe_name: value.name });
    if (!deleted) return res.status(404).json({ error: 'Recipe not found.' });
    res.json({ message: 'Recipe deleted successfully.' });
  })
);

// Optional: trigger a test error to verify Sentry (requires x-api-key)
app.get('/debug/sentry', (req, res, next) => {
  next(new Error('Sentry test error'));
});

/* ───────────────────────── ERROR HANDLERS ───────────────────── */

app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.use((err, req, res, next) => {
  // send to Sentry
  try { Sentry.captureException(err); } catch (_) {}

  // Mongo duplicate-key error → 409
  if (err && err.code === 11000) {
    return res.status(409).json({ error: 'Recipe name already exists.' });
  }

  // Joi validation error → 400
  if (err && err.isJoi) {
    return res.status(400).json({ error: err.details.map((d) => d.message) });
  }

  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

/* ───────────────────────── START SERVER ─────────────────────── */

app.listen(port, () => {
  console.log(`🚀 API running on port ${port}`);
});