// index.js
const express = require('express');
const mongoose = require('mongoose');
const dotenv = require('dotenv');
const morgan = require('morgan');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const Joi = require('joi');
const Sentry = require('@sentry/node');
const { nodeProfilingIntegration } = require('@sentry/profiling-node');

dotenv.config();
const app = express();
const port = process.env.PORT || 3000;

/* ----------------------- SENTRY ----------------------- */
Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.SENTRY_ENVIRONMENT || 'production',
  tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE || 0.02),
  integrations: [
    Sentry.httpIntegration(),
    nodeProfilingIntegration(),
  ],
  beforeSend(event) {
    if (event.request?.headers && event.request.headers['x-api-key']) {
      event.request.headers['x-api-key'] = '[REDACTED]';
    }
    return event;
  },
});
app.use(Sentry.requestHandler());
app.use(Sentry.tracingHandler());

/* -------------------- SECURITY & LOGS -------------------- */
app.use(helmet());
app.use(cors({ origin: '*', methods: ['GET','POST','PUT','DELETE','OPTIONS'] }));
app.use(morgan('tiny'));
app.use(rateLimit({ windowMs: 60_000, max: 100, message: { error: 'Too many requests' } }));
app.use(express.json({ limit: '1mb' }));

// SAFE sanitizer: clean only body & params; DO NOT touch req.query on Express 5
function stripMongoOps(obj) {
  if (!obj || typeof obj !== 'object') return;
  if (Array.isArray(obj)) return obj.forEach(stripMongoOps);
  for (const k of Object.keys(obj)) {
    if (k.startsWith('$') || k.includes('.')) { delete obj[k]; continue; }
    stripMongoOps(obj[k]);
  }
}
app.use((req, _res, next) => {
  try {
    if (req.body) stripMongoOps(req.body);
    if (req.params) stripMongoOps(req.params);
    next();
  } catch (e) { next(e); }
});

/* --------------------- DB CONNECTION --------------------- */
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ Connected to MongoDB'))
  .catch(err => console.error('❌ MongoDB connection error:', err));

/* ----------------------- MONGOOSE ------------------------ */
const recipeSchema = new mongoose.Schema({
  recipe_name: { type: String, required: true, unique: true },
  servings: { type: Number, required: true },
  ingredients: [{
    name: { type: String, required: true },
    quantity: { type: Number, required: true },
    unit: { type: String, required: true },
    unit_cost: { type: Number, required: true },
  }],
});
const Recipe = mongoose.model('Recipe', recipeSchema);

/* ----------------------- JOI SCHEMAS --------------------- */
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
const getRecipesQuerySchema = Joi.object({
  name: Joi.string().optional(),
  ingredient: Joi.string().optional(),
  page: Joi.number().integer().min(1).optional(),
  limit: Joi.number().integer().min(1).optional(),
});
const nameParamSchema = Joi.object({ name: Joi.string().required() });

/* ------------------------ HELPERS ------------------------ */
const requireApiKey = (req, res, next) => {
  const key = req.header('x-api-key');
  if (!key || key !== process.env.API_KEY) return res.status(401).json({ error: 'Unauthorized' });
  next();
};
const asyncHandler = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/* ----------------------- OPENAPI JSON -------------------- */
const openapi = {
  openapi: '3.0.0',
  info: { title: 'Recipe Cost API', version: '1.0.0', description: 'Calculate food costs & manage recipes' },
  servers: [{ url: process.env.BASE_URL || `http://localhost:${port}`, description: 'Primary server' }],
  components: {
    securitySchemes: { ApiKeyAuth: { type: 'apiKey', in: 'header', name: 'x-api-key' } },
    schemas: {
      Ingredient: { type: 'object', required: ['name','quantity','unit','unit_cost'],
        properties: { name:{type:'string'}, quantity:{type:'number'}, unit:{type:'string'}, unit_cost:{type:'number'} } },
      CalculateCost: { type: 'object', required: ['recipe_name','servings','ingredients'],
        properties: { recipe_name:{type:'string'}, servings:{type:'integer'}, markup_multiplier:{type:'number'},
          ingredients:{ type:'array', items:{ $ref:'#/components/schemas/Ingredient' } } } },
    },
  },
  security: [{ ApiKeyAuth: [] }],
  paths: {
    '/': { get: { summary: 'Health check', responses: { 200: { description: 'API is up and running' } } } },
    '/calculate-cost': { post: { summary: 'Calculate cost', responses: { 200:{description:'OK'}, 400:{}, 401:{} } } },
    '/save-recipe': { post: { summary: 'Save recipe', responses: { 201:{}, 400:{}, 401:{}, 409:{} } } },
    '/recipes': { get: { summary: 'List recipes', responses: { 200:{}, 401:{} } } },
    '/recipes/{name}': {
      get: { summary: 'Get recipe', responses: { 200:{}, 401:{}, 404:{} } },
      put: { summary: 'Update recipe', responses: { 200:{}, 400:{}, 401:{}, 404:{} } },
      delete: { summary: 'Delete recipe', responses: { 200:{}, 401:{}, 404:{} } },
    },
  },
};
app.get('/openapi.json', (_req, res) => res.json(openapi));

/* ----------------------- ROUTES -------------------------- */
// Public health check
app.get('/', (_req, res) => res.send('👨‍🍳 Recipe Cost API is up!'));

// Protect everything else
app.use(requireApiKey);

// Calculate cost
app.post('/calculate-cost', asyncHandler(async (req, res) => {
  const { error, value } = calculateCostSchema.validate(req.body, { abortEarly: false });
  if (error) return res.status(400).json({ error: error.details.map(d => d.message) });

  const { recipe_name, servings, ingredients, markup_multiplier } = value;
  const total = ingredients.reduce((s, i) => s + i.quantity * i.unit_cost, 0);
  const cps = total / servings;
  const mult = markup_multiplier || 3;
  const price = cps * mult;
  res.json({
    recipe_name,
    total_cost: +total.toFixed(2),
    cost_per_serving: +cps.toFixed(2),
    suggested_price_per_serving: +price.toFixed(2),
    profit_margin_per_serving: +(price - cps).toFixed(2),
    food_cost_percent: +((cps / price) * 100).toFixed(2),
  });
}));

// Save
app.post('/save-recipe', asyncHandler(async (req, res) => {
  const { error, value } = calculateCostSchema.validate(req.body, { abortEarly: false });
  if (error) return res.status(400).json({ error: error.details.map(d => d.message) });
  await new Recipe(value).save();
  res.status(201).json({ message: 'Recipe saved successfully.' });
}));

// List
app.get('/recipes', asyncHandler(async (req, res) => {
  const { error, value } = getRecipesQuerySchema.validate(req.query, { abortEarly: false });
  if (error) return res.status(400).json({ error: error.details.map(d => d.message) });

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
}));

// Get one
app.get('/recipes/:name', asyncHandler(async (req, res) => {
  const { error, value } = nameParamSchema.validate(req.params, { abortEarly: false });
  if (error) return res.status(400).json({ error: error.details.map(d => d.message) });
  const r = await Recipe.findOne({ recipe_name: value.name });
  if (!r) return res.status(404).json({ error: 'Recipe not found.' });
  res.json(r);
}));

// Update
app.put('/recipes/:name', asyncHandler(async (req, res) => {
  const { error: pe, value: pv } = nameParamSchema.validate(req.params, { abortEarly: false });
  if (pe) return res.status(400).json({ error: pe.details.map(d => d.message) });
  const { error: be, value: bv } = calculateCostSchema.validate(req.body, { abortEarly: false });
  if (be) return res.status(400).json({ error: be.details.map(d => d.message) });

  const updated = await Recipe.findOneAndUpdate({ recipe_name: pv.name }, bv, { new: true, runValidators: true });
  if (!updated) return res.status(404).json({ error: 'Recipe not found.' });
  res.json(updated);
}));

// Delete
app.delete('/recipes/:name', asyncHandler(async (req, res) => {
  const { error, value } = nameParamSchema.validate(req.params, { abortEarly: false });
  if (error) return res.status(400).json({ error: error.details.map(d => d.message) });
  const del = await Recipe.findOneAndDelete({ recipe_name: value.name });
  if (!del) return res.status(404).json({ error: 'Recipe not found.' });
  res.json({ message: 'Recipe deleted successfully.' });
}));

/* -------------------- ERROR HANDLING --------------------- */
app.use(Sentry.errorHandler());
app.use((req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, _req, res, _next) => {
  console.error(err);
  if (err.code === 11000) return res.status(409).json({ error: 'Recipe name already exists.' });
  if (err.isJoi) return res.status(400).json({ error: err.details.map(d => d.message) });
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

/* ------------------------ START -------------------------- */
app.listen(port, () => console.log(`🚀 API running on port ${port}`));