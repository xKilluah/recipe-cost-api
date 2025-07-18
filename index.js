// index.js

const express = require('express');
const mongoose = require('mongoose');
const dotenv = require('dotenv');
const rateLimit = require('express-rate-limit');
const morgan = require('morgan');
const Joi = require('joi');

dotenv.config();
const app = express();
const port = process.env.PORT || 3000;

app.use(morgan('tiny'));
app.use(rateLimit({
  windowMs: 60_000,
  max: 100,
  message: { error: 'Too many requests, please try again later.' }
}));
app.use(express.json());

const requireApiKey = (req, res, next) => {
  const key = req.header('x-api-key');
  if (!key || key !== process.env.API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
};

mongoose
  .connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ Connected to MongoDB'))
  .catch(err => console.error('❌ MongoDB connection error:', err));

const recipeSchema = new mongoose.Schema({
  recipe_name: { type: String, required: true, unique: true },
  servings:    { type: Number, required: true },
  ingredients: [{
    name:      String,
    quantity:  Number,
    unit:      String,
    unit_cost: Number
  }]
});
const Recipe = mongoose.model('Recipe', recipeSchema);

// Joi schemas (omitted here for brevity – same as before)

// Helper to wrap async route handlers
const asyncHandler = fn => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

// Public health-check
app.get('/', (req, res) =>
  res.send('👨‍🍳 Recipe Cost API is up and running!')
);

// All routes below need an API key
app.use(requireApiKey);

// Calculate cost
app.post('/calculate-cost', asyncHandler(async (req, res) => {
  const { error, value } = calculateCostSchema.validate(req.body);
  if (error) return res.status(400).json({ error: error.details.map(d => d.message) });
  // … calculation logic …
  res.json({ /* … result … */ });
}));

// Save recipe
app.post('/save-recipe', asyncHandler(async (req, res) => {
  const { error, value } = saveRecipeSchema.validate(req.body);
  if (error) return res.status(400).json({ error: error.details.map(d => d.message) });
  const recipe = new Recipe(value);
  await recipe.save();
  res.status(201).json({ message: 'Recipe saved successfully.' });
}));

// List recipes
app.get('/recipes', asyncHandler(async (req, res) => {
  // … validation + query …
  res.json({ /* … paginated data … */ });
}));

// Get one
app.get('/recipes/:name', asyncHandler(async (req, res) => {
  // … validation + lookup …
  res.json(recipe);
}));

// Update
app.put('/recipes/:name', asyncHandler(async (req, res) => {
  // … validate params & body, then update …
  res.json(updated);
}));

// Delete
app.delete('/recipes/:name', asyncHandler(async (req, res) => {
  // … validate params, then delete …
  res.json({ message: 'Recipe deleted successfully.' });
}));

// 404 for unknown routes
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Central error handler
app.use((err, req, res, next) => {
  console.error(err);
  if (err.isJoi) {
    // Joi validation error
    return res.status(400).json({ error: err.details.map(d => d.message) });
  }
  res.status(err.status || 500).json({
    error: err.message || 'Internal server error'
  });
});

app.listen(port, () => console.log(`🚀 API running on port ${port}`));