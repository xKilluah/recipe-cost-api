// index.js

const express               = require('express');
const mongoose              = require('mongoose');
const dotenv                = require('dotenv');
const helmet                = require('helmet');
const cors                  = require('cors');
const rateLimit             = require('express-rate-limit');
const morgan                = require('morgan');
const xss                   = require('xss-clean');
const mongoSanitize         = require('express-mongo-sanitize');
const Joi                   = require('joi');
const swaggerJsdoc          = require('swagger-jsdoc');
const swaggerUi             = require('swagger-ui-express');

// Load env
dotenv.config();

const app  = express();
const port = process.env.PORT || 3000;

// ── Security ───────────────────────────────────────────
app.use(helmet());
app.use(cors());
app.use(xss());
app.use(mongoSanitize());   // <<< properly sanitizes body, query, params

// ── Logging & Rate Limit ───────────────────────────────
app.use(morgan('tiny'));
app.use(rateLimit({
  windowMs: 60_000,
  max: 100,
  message: { error: 'Too many requests, please try again later.' }
}));

// ── Body Parsing ────────────────────────────────────────
app.use(express.json());

// ── API Key Middleware ──────────────────────────────────
const requireApiKey = (req, res, next) => {
  const key = req.header('x-api-key');
  if (!key || key !== process.env.API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
};

// Wrap async for brevity
const asyncHandler = fn => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

// ── Swagger Setup ───────────────────────────────────────
const swaggerDefinition = {
  openapi: '3.0.0',
  info: {
    title: 'Recipe Cost API',
    version: '1.0.0',
    description: 'Calculate food costs & manage recipes',
  },
  servers: [{
    url: process.env.BASE_URL || `http://localhost:${port}`,
    description: 'Primary server'
  }],
  components: {
    securitySchemes: {
      ApiKeyAuth: { type: 'apiKey', in: 'header', name: 'x-api-key' }
    }
  },
  security: [{ ApiKeyAuth: [] }]
};
const swaggerSpec = swaggerJsdoc({
  swaggerDefinition,
  apis: ['./index.js']
});
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec, { explorer: true }));

// ── MongoDB ─────────────────────────────────────────────
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ Connected to MongoDB'))
  .catch(err => console.error('❌ MongoDB connection error:', err));

// ── Mongoose Model ──────────────────────────────────────
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

// ── Joi Schemas ─────────────────────────────────────────
const ingredientSchema = Joi.object({
  name:      Joi.string().required(),
  quantity:  Joi.number().positive().required(),
  unit:      Joi.string().required(),
  unit_cost: Joi.number().min(0).precision(4).required()
});
const calculateCostSchema = Joi.object({
  recipe_name:       Joi.string().required(),
  servings:          Joi.number().integer().min(1).required(),
  ingredients:       Joi.array().items(ingredientSchema).min(1).required(),
  markup_multiplier: Joi.number().positive().optional()
});
const saveRecipeSchema       = calculateCostSchema;
const getRecipesQuerySchema  = Joi.object({
  name:       Joi.string().optional(),
  ingredient: Joi.string().optional(),
  page:       Joi.number().integer().min(1).optional(),
  limit:      Joi.number().integer().min(1).optional()
});
const nameParamSchema = Joi.object({ name: Joi.string().required() });

// ── Routes ──────────────────────────────────────────────

/** Health check */
app.get('/', (req, res) => {
  res.send('👨‍🍳 Recipe Cost API is up!');
});

// Protect everything below
app.use(requireApiKey);

/** Calculate cost */
app.post('/calculate-cost', asyncHandler(async (req, res) => {
  const { error, value } = calculateCostSchema.validate(req.body, { abortEarly: false });
  if (error) return res.status(400).json({ error: error.details.map(d => d.message) });

  const { recipe_name, servings, ingredients, markup_multiplier } = value;
  const totalCost      = ingredients.reduce((sum, i) => sum + i.quantity * i.unit_cost, 0);
  const costPerServing = totalCost / servings;
  const m              = markup_multiplier || 3;
  const suggestedPrice = costPerServing * m;

  res.json({
    recipe_name,
    total_cost:                  +totalCost.toFixed(2),
    cost_per_serving:            +costPerServing.toFixed(2),
    suggested_price_per_serving: +suggestedPrice.toFixed(2),
    profit_margin_per_serving:   +(suggestedPrice - costPerServing).toFixed(2),
    food_cost_percent:           +((costPerServing / suggestedPrice) * 100).toFixed(2)
  });
}));

/** Save recipe */
app.post('/save-recipe', asyncHandler(async (req, res) => {
  const { error, value } = saveRecipeSchema.validate(req.body, { abortEarly: false });
  if (error) return res.status(400).json({ error: error.details.map(d => d.message) });

  await new Recipe(value).save();
  res.status(201).json({ message: 'Recipe saved successfully.' });
}));

/** List recipes */
app.get('/recipes', asyncHandler(async (req, res) => {
  const { error, value } = getRecipesQuerySchema.validate(req.query, { abortEarly: false });
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

/** Get one */
app.get('/recipes/:name', asyncHandler(async (req, res) => {
  const { error, value } = nameParamSchema.validate(req.params, { abortEarly: false });
  if (error) return res.status(400).json({ error: error.details.map(d => d.message) });

  const rec = await Recipe.findOne({ recipe_name: value.name });
  if (!rec) return res.status(404).json({ error: 'Recipe not found.' });
  res.json(rec);
}));

/** Update */
app.put('/recipes/:name', asyncHandler(async (req, res) => {
  const { error: pErr, value: pVal } = nameParamSchema.validate(req.params, { abortEarly: false });
  if (pErr) return res.status(400).json({ error: pErr.details.map(d => d.message) });

  const { error: bErr, value: bVal } = saveRecipeSchema.validate(req.body, { abortEarly: false });
  if (bErr) return res.status(400).json({ error: bErr.details.map(d => d.message) });

  const updated = await Recipe.findOneAndUpdate(
    { recipe_name: pVal.name },
    bVal,
    { new: true, runValidators: true }
  );
  if (!updated) return res.status(404).json({ error: 'Recipe not found.' });
  res.json(updated);
}));

/** Delete */
app.delete('/recipes/:name', asyncHandler(async (req, res) => {
  const { error, value } = nameParamSchema.validate(req.params, { abortEarly: false });
  if (error) return res.status(400).json({ error: error.details.map(d => d.message) });

  const deleted = await Recipe.findOneAndDelete({ recipe_name: value.name });
  if (!deleted) return res.status(404).json({ error: 'Recipe not found.' });
  res.json({ message: 'Recipe deleted successfully.' });
}));

// 404 handler
app.use((req, res) => res.status(404).json({ error: 'Not found' }));

// Error handler
app.use((err, req, res, next) => {
  console.error(err);
  if (err.code === 11000) return res.status(409).json({ error: 'Recipe name already exists.' });
  if (err.isJoi)        return res.status(400).json({ error: err.details.map(d => d.message) });
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

// ── Start ───────────────────────────────────────────────────
app.listen(port, () => {
  console.log(`🚀 API running on port ${port}`);
});